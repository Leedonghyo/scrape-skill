#!/usr/bin/env node
/*
 * collect.mjs — run one recipe (see references/recipe.md) and write rows to a file.
 *
 * Progress goes to stderr; the LAST stdout line is one JSON summary the calling model reads.
 * Exit codes: 0 ok · 1 usage/recipe error · 2 environment (browser) error · 3 blocked / login required.
 *
 * Design rule: this tool never bypasses bot protection. It detects a block and hands over to the human
 * (--wait-for-human), or stops and says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  SCRIPTS_DIR, HELPERS_PATH, SCRAPE_HOME, FORMATS,
  UsageError, EnvError, BlockedError,
  expandHome, sleep, isEmpty, hasAnyValue, shorten, localDate, jittered, parseArgs, loadRecipe,
  defaultHeaders, mergeHeaders, loadStorageState, cookieHeader, detectBlockedHttp,
  jsonRows, extractEmbedded, writeRows, fillRate, unionColumns, tryParse, cursorUrl, fillBody, nextCursor,
} from './lib.mjs';

const USAGE = `usage: node collect.mjs <recipe.json | recipe-name> [--max-pages N] [--limit N] [--dry-run] [--out PATH]
          [--format csv|json|jsonl] [--headless|--headful] [--resume] [--wait-for-human] [--cdp PORT|URL] [--quiet]
A bare name resolves to ~/.scrape/recipes/<name>.json.
--cdp attaches to a Chrome you started with --remote-debugging-port (your real browser) instead of launching one;
      it is never closed on exit. For sites even that cannot pass, see the real-browser fallback in SKILL.md.`;
const ARGS = { 'max-pages': 'number', limit: 'number', 'dry-run': 'boolean', out: 'string', format: 'string', headless: 'boolean', headful: 'boolean', resume: 'boolean', 'wait-for-human': 'boolean', cdp: 'string', quiet: 'boolean', help: 'boolean' };
const NAV_TIMEOUT = 45_000;
const HUMAN_WAIT_MS = 5 * 60_000;
const INTERCEPT_TIMEOUT = 10_000; // default intercept.timeout_ms
const INTERCEPT_SETTLE_MS = 100;  // default intercept.settle_ms: quiet time after the last matching call before moving on
// Block kinds a person can actually clear by acting in the browser window. Everything else (access_denied,
// rate_limited, bot_page) is a hard refusal that waiting cannot change.
const SOLVABLE_BY_HUMAN = new Set(['js_challenge', 'turnstile', 'captcha', 'login_required']);
// The stdout summary is read by the calling model. A detail-page body can run to thousands of characters,
// which once made that one line 4.5KB and led a caller to re-run the whole collection just to capture it.
const trimRow = (row) => Object.fromEntries(Object.entries(row || {}).map(([k, v]) => [k, typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v]));

// Last-resort cleanup for the collector's OWN Chrome (never a --cdp browser, which is the user's): the profile
// path is unique to this tool, so matching the command line on it only hits processes we launched. Used when
// context.close() hangs (a navigation mid-flight during Ctrl-C) or on a second interrupt, so no window is left behind.
function killOwnChrome() {
  const profile = path.join(SCRAPE_HOME, 'profile');
  try {
    if (process.platform === 'win32') {
      spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore', timeout: 8000 });
    } else {
      spawnSync('pkill', ['-f', profile], { stdio: 'ignore', timeout: 5000 });
    }
  } catch { /* best effort */ }
}
// The fetch/XHR hook behind requestOrigins() is an analysis aid for the interactive browser; a collection run
// never reads it, so it is not installed here.
const HELPERS_SRC = 'window.__scrape_no_net = true;\n' + fs.readFileSync(HELPERS_PATH, 'utf8');

class Collector {
  constructor(recipe, opts) {
    this.recipe = recipe;
    this.opts = opts;
    this.pages = recipe.pages;
    this.rate = recipe.rate || {};
    this.dry = !!opts['dry-run'];
    this.rows = [];        // rows collected in this run (kept in memory for fill rate / json output)
    this.flushed = 0;      // rows already written to disk
    this.previousRows = 0; // rows a resumed run had already written
    this.seen = new Set(); // dedupe keys
    this.requests = 0;
    this.detailCount = 0;
    this.pagesDone = 0;
    this.stop = null;      // stopped_reason
    this.blockedBy = null;
    this.error = null;
    this.cursor = null;    // cursor of the page being fetched (saved on block so --resume retries it)
    this.intercepted = new Set(); // strategy intercept: url + body hash of every response already used
    this.responses = 0;    // strategy intercept: JSON responses captured and used
    this.session = loadStorageState(recipe.session?.cookies_file);
    this.t0 = Date.now();
  }

  log(msg) { if (!this.opts.quiet) console.error(`[collect] ${msg}`); }

  // ---------- output & resume ----------
  prepareOutput() {
    const o = this.recipe.output || {};
    const name = this.recipe.name;
    let format = this.opts.format || o.format || 'csv';
    const date = localDate();
    let file = this.opts.out
      ? path.resolve(expandHome(this.opts.out))
      : expandHome((o.path || `~/Downloads/{name}-{date}.${format}`).replaceAll('{name}', name).replaceAll('{date}', date));
    // `--out rows.jsonl` without --format: the extension is the clearest signal of what the user wants.
    const ext = path.extname(file).slice(1).toLowerCase();
    if (this.opts.out && !this.opts.format && FORMATS.includes(ext)) format = ext;
    if (!FORMATS.includes(format)) throw new UsageError(`format must be one of ${FORMATS.join(', ')}`);
    this.stateFile = path.join(SCRAPE_HOME, 'state', `${name}.json`);
    if (this.opts.resume && !this.dry) {
      const st = fs.existsSync(this.stateFile) ? JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) : null;
      if (st && !st.done && st.cursor) {
        this.resumeFrom = st;
        if (!this.opts.out && st.output) file = st.output;
        if (!this.opts.format && st.format) format = st.format;
        this.columns = st.columns;
        this.seen = new Set(st.seen || []);
        this.previousRows = st.rows_written || 0;
        if (format === 'json' && fs.existsSync(file)) { try { this.previousJson = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.previousJson = []; } }
        this.log(`resuming at ${JSON.stringify(st.cursor)}; ${this.previousRows} rows already in ${file}`);
      } else this.log('nothing to resume (no unfinished state); starting fresh');
    }
    this.format = format;
    this.file = file;
  }

  flush() {
    if (this.dry) return;
    const fresh = this.rows.slice(this.flushed);
    if (!fresh.length) return;
    if (!this.columns) this.columns = unionColumns(this.recipe.fields, this.recipe.detail?.fields, fresh);
    const append = this.flushed > 0 || !!this.resumeFrom;
    if (this.format === 'json') writeRows({ file: this.file, format: 'json', rows: [...(this.previousJson || []), ...this.rows], columns: this.columns });
    else writeRows({ file: this.file, format: this.format, rows: fresh, columns: this.columns, append });
    this.flushed = this.rows.length;
  }

  saveState(cursor, extra = {}) {
    if (this.dry) return;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const st = {
      recipe: this.recipe.name, cursor, done: !cursor, output: this.file, format: this.format, columns: this.columns,
      rows_written: this.previousRows + this.rows.length, pages_done: this.pagesDone, updated_at: new Date().toISOString(), ...extra,
    };
    if (this.recipe.output?.dedupe_key) st.seen = [...this.seen];
    fs.writeFileSync(this.stateFile, JSON.stringify(st, null, 2));
  }

  // ---------- rows ----------
  dedupe(rows) {
    const key = this.recipe.output?.dedupe_key;
    if (!key) return rows;
    return rows.filter((r) => {
      if (isEmpty(r[key])) return true;
      const k = String(r[key]);
      if (this.seen.has(k)) return false;
      this.seen.add(k);
      return true;
    });
  }

  // Dedupe → cap to --limit → fetch detail pages → keep. Returns the rows actually kept.
  async acceptRows(rows) {
    rows = this.dedupe(rows);
    const limit = this.opts.limit;
    if (limit) rows = rows.slice(0, Math.max(0, limit - this.rows.length));
    await this.details(rows);
    this.rows.push(...rows);
    return rows;
  }

  limitReached() { return !!this.opts.limit && this.rows.length >= this.opts.limit; }

  async pause() { if (this.requests++ > 0) await sleep(jittered(this.rate)); }

  // ---------- page enumeration ----------
  // Page i of this run → { url, n?, index?, click? } or null when the list is exhausted.
  targetAt(i, prev) {
    const p = this.pages;
    const r = this.resumeFrom?.cursor || {};
    switch (p.type) {
      case 'single': return i === 0 ? { url: r.url || p.start } : null;
      case 'urls': { const idx = (r.index || 0) + i; return p.urls[idx] ? { url: p.urls[idx], index: idx } : null; }
      case 'param': {
        const n = (r.n ?? p.start_n ?? 1) + i * (p.step ?? 1);
        const tmpl = this.recipe.strategy === 'http' ? this.recipe.http?.url_template || p.template : p.template;
        return { url: tmpl.replaceAll('{n}', String(n)), n };
      }
      case 'next_link': return i === 0 ? { url: r.url || p.start } : prev?.next ? prev.next : null;
      case 'cursor': { // http only; each request needs the cursor the previous response returned
        if (i > 0 && (!prev || prev.cursorEnd)) return null;
        const value = i === 0 ? r.value ?? p.start_cursor ?? '' : prev.nextCursor;
        return { url: cursorUrl(this.recipe.http.url_template, value), cursorValue: value };
      }
      default: return null;
    }
  }
  // Cursor to persist after page i succeeded (what --resume starts from).
  cursorAfter(target, result) {
    switch (this.pages.type) {
      case 'urls': return this.pages.urls[target.index + 1] ? { index: target.index + 1 } : null;
      case 'param': return { n: target.n + (this.pages.step ?? 1) };
      case 'next_link': return result.next ? { url: result.next.url || result.pageUrl } : null;
      case 'cursor': return result.cursorEnd ? null : { value: result.nextCursor };
      default: return null;
    }
  }

  async run() {
    this.prepareOutput();
    const type = this.pages.type;
    const maxPages = this.opts['max-pages'] ?? (type === 'scroll' ? this.pages.max_rounds ?? 20 : this.pages.max_pages ?? 20);
    // intercept + cursor: the page pages itself (scroll / "load more"); we only watch the cursor to know when it ends.
    if (type === 'scroll' || (type === 'cursor' && this.recipe.strategy === 'intercept')) return this.runScroll(maxPages);
    if (type === 'cursor' && (this.rate.concurrency || 1) > 1) this.log('cursor pagination is sequential; ignoring rate.concurrency');
    const endReason = type === 'next_link' ? 'no_next_link' : type === 'cursor' ? 'cursor_end' : 'end_of_list';
    const stopWhenEmpty = this.pages.stop_when_empty !== false;
    const total = type === 'single' ? 1 : type === 'urls' ? Math.min(this.pages.urls.length - (this.resumeFrom?.cursor?.index || 0), maxPages) : maxPages;
    // http pages are independent, so rate.concurrency can fetch a window of them at once (one pause per window).
    const conc = this.recipe.strategy === 'http' && ['param', 'urls'].includes(type) ? Math.max(1, this.rate.concurrency || 1) : 1;
    const inflight = new Map();
    const visited = new Set();
    let prev = null;
    for (let i = 0; i < maxPages; i++) {
      if (this.aborted) { this.stop = 'interrupted'; break; }
      const target = this.targetAt(i, prev);
      if (!target) { this.stop = endReason; break; }
      if (target.url && visited.has(target.url) && type === 'next_link') { this.stop = 'no_next_link'; break; }
      visited.add(target.url);
      this.cursor = type === 'param' ? { n: target.n } : type === 'urls' ? { index: target.index } : type === 'cursor' ? { value: target.cursorValue } : { url: target.url };
      let result;
      if (conc > 1) {
        if (!inflight.has(i)) {
          await this.pause();
          for (let k = i; k < i + conc && k < maxPages; k++) {
            const t = this.targetAt(k);
            if (!t) break;
            const pr = this.fetchPage(t, false);
            pr.catch(() => {}); // a sibling failure must not become an unhandled rejection; it is awaited in order below
            inflight.set(k, pr);
          }
        }
        result = await inflight.get(i);
        inflight.delete(i);
      } else result = await this.fetchPage(target, true);
      prev = result;
      this.pagesDone++;
      const kept = await this.acceptRows(result.rows);
      this.log(`page ${i + 1}/${total} → ${kept.length} rows (total ${this.previousRows + this.rows.length})`);
      if (!kept.length && stopWhenEmpty) { this.stop = result.cursorEnd ? 'cursor_end' : result.rows.length ? 'all_duplicates' : 'empty_page'; this.saveState(null); break; } // list exhausted: mark done so --resume starts fresh
      this.flush();
      const next = this.cursorAfter(target, result);
      this.saveState(next);
      if (!next) { this.stop = endReason; break; }
      if (this.limitReached()) { this.stop = 'limit'; break; }
      if (this.dry) { this.stop = 'dry_run'; break; }
    }
    if (!this.stop) this.stop = 'max_pages';
  }

  // Infinite scroll: one navigation, then scroll/click until the item count stops growing.
  async runScroll(maxRounds) {
    const page = await this.page();
    await this.pause();
    // intercept: growth is measured in captured API responses instead of DOM items; the listener goes on before the navigation.
    const cap = this.recipe.strategy === 'intercept' ? this.capture(page) : null;
    const hits = [];
    // pages.type cursor: the first load is page 1, every round after it one more; the run ends when a response's cursor does.
    const cursorPath = this.pages.type === 'cursor' ? this.pages.cursor_path : null;
    const first = cursorPath ? 1 : 0;
    let cursor = '';
    let ended = false;
    const take = async (waitFirst) => {
      const fresh = await this.settle(cap, page, waitFirst);
      hits.push(...fresh);
      if (cursorPath) for (const h of fresh) { const c = nextCursor(h.data, cursorPath, cursor); if (c.end) ended = true; else cursor = c.value; }
    };
    let rows;
    try {
      await this.navigate(page, this.pages.start, this.recipe.wait);
      if (cap) await take(true);
      this.pagesDone = first;
      const container = this.recipe.items?.container || null;
      const count = async () => {
        if (cap) { await take(false); return hits.length; }
        return page.evaluate((c) => (c ? document.querySelectorAll(c).length : (document.scrollingElement || document.documentElement).scrollHeight), container);
      };
      const idle = this.pages.idle_ms ?? 1500;
      let last = await count();
      let stale = 0;
      for (let round = 1; round <= maxRounds - first && !ended && !this.aborted; round++) {
        const clicked = this.pages.load_more_selector
          ? await page.evaluate((s) => { const b = document.querySelector(s); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; }, this.pages.load_more_selector)
          : false;
        if (!clicked) await page.evaluate(() => window.scrollTo(0, (document.scrollingElement || document.documentElement).scrollHeight));
        await sleep(idle);
        const now = await count();
        this.pagesDone = round + first;
        this.log(`scroll round ${round}/${maxRounds - first} → ${now} ${cap ? 'responses' : container ? 'items' : 'px'}`);
        if (now <= last && ++stale >= 2) { this.stop = 'scroll_idle'; break; } // one grace round for slow loaders
        if (now > last) stale = 0;
        last = now;
      }
      if (this.aborted) this.stop = 'interrupted';
      if (!this.stop) this.stop = 'max_pages';
      if (ended) this.stop = 'cursor_end';
      if (cap && !hits.length) this.stop = 'empty_page'; // nothing matched intercept.url_match at all
      rows = cap ? this.hitRows(hits) : await this.extractDom(page, this.recipe.fields, container);
    } finally { cap?.stop(); }
    const kept = await this.acceptRows(rows);
    this.log(`extracted ${kept.length} rows after scrolling`);
    this.flush();
    this.saveState(null);
    if (this.dry) this.stop = 'dry_run';
  }

  // ---------- one page → rows ----------
  async fetchPage(target, pause) {
    if (this.recipe.strategy === 'dom' || this.recipe.strategy === 'intercept') return this.domPage(target, pause);
    return this.jsonPage(target, pause);
  }

  async domPage(target, pause) {
    const page = await this.page();
    if (pause) await this.pause();
    // intercept: the listener must exist before the navigation or click that makes the page call its API.
    const cap = this.recipe.strategy === 'intercept' ? this.capture(page) : null;
    try {
      if (target.click) {
        // "next" is a button, not a link: click it and give the page time to swap content or navigate.
        await page.locator(this.pages.next_selector).first().click({ timeout: 10_000 });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        await this.inject(page);
        await this.guard(page);
        await this.applyWait(page, this.recipe.wait);
      } else await this.navigate(page, target.url, this.recipe.wait);
      const rows = cap ? this.hitRows(await this.settle(cap, page)) : await this.extractDom(page, this.recipe.fields, this.recipe.items?.container);
      let next = null;
      if (this.pages.type === 'next_link') {
        next = await page.evaluate((sel) => {
          const a = document.querySelector(sel);
          if (!a) return null;
          const href = a.getAttribute('href');
          if (href && !/^(#|javascript:)/i.test(href.trim())) return { url: new URL(href, location.href).href };
          return { click: true };
        }, this.pages.next_selector);
      }
      return { rows, next, pageUrl: page.url() };
    } finally { cap?.stop(); }
  }

  // ---------- intercept: rows from the JSON the page itself fetches ----------
  // The API answers the real browser (right TLS/HTTP fingerprint, cookies, tokens the page computes) even when
  // a bare HTTP client gets a 403, so we read the response the page already received instead of re-requesting it.
  // Nothing is replayed, signed or forged here. Kept: URL matches intercept.url_match, method matches when given,
  // content-type is JSON, and the same URL + body was not already used in this run.
  capture(page) {
    const ic = this.recipe.intercept;
    const re = new RegExp(ic.url_match);
    const method = ic.method ? String(ic.method).toUpperCase() : null;
    const cap = { hits: [], matched: 0, pending: new Set(), inflight: new Set(), denied: null };
    const wanted = (req) => re.test(req.url()) && (!method || req.method().toUpperCase() === method);
    // Matching requests still on the wire: settle() waits for these instead of sleeping a fixed time.
    const onRequest = (req) => { if (wanted(req)) cap.inflight.add(req); };
    const onFailed = (req) => { cap.inflight.delete(req); };
    const onResponse = (resp) => {
      const url = resp.url();
      cap.inflight.delete(resp.request());
      if (!wanted(resp.request())) return;
      const status = resp.status();
      const headers = resp.headers();
      if (status === 401 || status === 403 || status === 429) { cap.matched++; cap.denied = cap.denied || { status, url, headers }; return; }
      if (status >= 400 || !/json/i.test(headers['content-type'] || '')) return; // an error body is not data
      const seq = cap.matched++;
      const p = resp.text().then((text) => {
        const data = tryParse(text);
        if (data === undefined) return;
        const key = url + '\n' + createHash('sha1').update(text).digest('hex');
        if (this.intercepted.has(key)) return;
        this.intercepted.add(key);
        cap.hits.push({ seq, url, data });
      }, () => { /* body gone: the page navigated away mid-read */ }).finally(() => cap.pending.delete(p));
      cap.pending.add(p);
    };
    page.on('request', onRequest);
    page.on('requestfailed', onFailed);
    page.on('response', onResponse);
    cap.stop = () => { page.off('request', onRequest); page.off('requestfailed', onFailed); page.off('response', onResponse); };
    return cap;
  }

  // New responses since the last call, in arrival order. waitFirst: give the page intercept.timeout_ms to make
  // the call at all, then wait until no matching request is in flight and none has arrived for settle_ms
  // (a page may call the API more than once). A fixed 400 ms here used to cost ~0.4 s on every page.
  async settle(cap, page, waitFirst = true) {
    const timeout = this.recipe.intercept.timeout_ms ?? INTERCEPT_TIMEOUT;
    if (waitFirst) {
      const deadline = Date.now() + timeout;
      const quiet = this.recipe.intercept.settle_ms ?? INTERCEPT_SETTLE_MS;
      while (!cap.matched && Date.now() < deadline && !this.aborted) await sleep(25);
      for (let n = -1; (n !== cap.matched || cap.inflight.size) && Date.now() < deadline + quiet && !this.aborted;) { n = cap.matched; await sleep(quiet); }
    }
    await Promise.race([Promise.allSettled([...cap.pending]), sleep(5000)]);
    const hits = cap.hits.splice(0).sort((a, b) => a.seq - b.seq);
    const denied = cap.denied;
    cap.denied = null;
    if (!hits.length && denied) {
      // The API refused the browser itself. That is a block (or a missing login), not an empty page.
      if (denied.status === 401) throw new BlockedError('login_required', { kind: 'login_required', url: denied.url, status: 401, signals: ['http 401', 'intercepted API response'] });
      const b = detectBlockedHttp(denied.status, denied.headers, '');
      throw new BlockedError('blocked', { vendor: b.vendor, kind: b.kind, url: denied.url, status: denied.status, signals: [...b.signals, 'intercepted API response'] });
    }
    if (waitFirst && !cap.matched) this.log(`no JSON response matched intercept.url_match within ${timeout} ms on ${shorten(page.url(), 80)}`);
    cap.matched = 0;
    this.responses += hits.length;
    return hits;
  }

  hitRows(hits) { return hits.flatMap((h) => jsonRows(h.data, this.recipe.items, this.recipe.fields)); }

  async jsonPage(target, pause) {
    if (pause) await this.pause();
    const r = this.recipe;
    const isHttp = r.strategy === 'http';
    const vars = {}; // placeholders for http.body; the URL was already filled by targetAt
    if (target.n != null) vars.n = target.n;
    if (this.pages.type === 'cursor') vars.cursor = target.cursorValue;
    const res = await this.fetchText(target.url, isHttp ? r.http : null, isHttp ? 'json' : 'html', vars);
    if (res.status === 404 || res.status === 410) return { rows: [] }; // past the last page: let stop_when_empty end the run
    const data = isHttp ? this.parseJson(res) : extractEmbedded(res.text, r.embedded.source);
    const out = { rows: jsonRows(data, r.items, r.fields) };
    if (this.pages.type === 'cursor') {
      const c = nextCursor(data, this.pages.cursor_path, target.cursorValue);
      out.nextCursor = c.value;
      out.cursorEnd = c.end;
    }
    return out;
  }

  parseJson(res) {
    try { return JSON.parse(res.text); } catch { /* fall through */ }
    if (/<input[^>]+type=["']?password/i.test(res.text)) throw new BlockedError('login_required', { kind: 'login_required', url: res.url });
    throw new UsageError(`response from ${res.url} is not JSON (content-type ${res.contentType || 'unknown'}); the endpoint may need cookies or headers — check it with probe-http.mjs`);
  }

  async fetchText(url, http, kind, vars) {
    const headers = mergeHeaders(defaultHeaders(kind), this.recipe.session?.headers, http?.headers);
    const cookie = this.session ? cookieHeader(this.session.cookies, url) : null;
    if (cookie && !headers.cookie) headers.cookie = cookie;
    let body;
    if (http?.body != null) {
      body = fillBody(http.body, vars);
      if (typeof http.body !== 'string' && !headers['content-type']) headers['content-type'] = 'application/json';
    }
    let res;
    try {
      res = await fetch(url, { method: http?.method || 'GET', headers, body, redirect: 'follow', signal: AbortSignal.timeout(NAV_TIMEOUT) });
    } catch (e) { throw new Error(`request failed for ${url}: ${e.cause?.message || e.message}`); }
    const text = await res.text();
    const b = detectBlockedHttp(res.status, res.headers, text);
    if (b.blocked) throw new BlockedError('blocked', { vendor: b.vendor, kind: b.kind, url, status: res.status, signals: b.signals });
    if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`HTTP ${res.status} for ${url}`);
    return { status: res.status, text, url: res.url, contentType: res.headers.get('content-type') };
  }

  // ---------- detail pages ----------
  async details(rows) {
    const d = this.recipe.detail;
    if (!d || !rows.length) return;
    const max = this.dry ? Math.min(3, d.max_items ?? 3) : d.max_items ?? Infinity;
    for (const row of rows) {
      if (this.detailCount >= max || this.aborted) break;
      let url = row[d.url_field];
      if (!url || typeof url !== 'string') continue;
      if (!/^https?:\/\//i.test(url)) { try { url = new URL(url, this.recipe.source).href; } catch { continue; } }
      this.detailCount++;
      try {
        let extra;
        if (d.strategy === 'embedded') {
          await this.pause();
          const res = await this.fetchText(url, null, 'html');
          extra = jsonRows(extractEmbedded(res.text, d.embedded?.source ?? this.recipe.embedded?.source), d.items, d.fields)[0];
        } else {
          const page = await this.page();
          await this.pause();
          await this.navigate(page, url, d.wait);
          extra = (await this.extractDom(page, d.fields, d.container))[0];
        }
        // Detail values win, but never erase a list value with an empty one.
        for (const [k, v] of Object.entries(extra || {})) if (!isEmpty(v) || !(k in row)) row[k] = v;
        this.log(`  detail ${this.detailCount}${Number.isFinite(max) ? '/' + max : ''}: ${shorten(url, 70)}`);
      } catch (e) {
        if (e instanceof BlockedError) throw e;
        this.log(`  detail failed (${shorten(url, 70)}): ${e.message.split('\n')[0]}`);
      }
    }
  }

  // ---------- browser ----------
  async page() {
    if (this._page) return this._page;
    let pw;
    try { pw = await import('playwright-core'); } catch { throw new EnvError(`playwright-core is not installed. Run: cd "${SCRIPTS_DIR}" && npm install --omit=dev`); }
    // --cdp: attach to a Chrome the user already started with --remote-debugging-port, i.e. their real,
    // non-automated browser. It carries their real profile/fingerprint, so some protections that block a
    // freshly launched Playwright browser let it through. Not guaranteed against strong anti-bot (Akamai
    // etc. can still detect CDP); when it is not enough, use the real-browser fallback in SKILL.md. We
    // never close the user's browser here — see close().
    if (this.opts.cdp) {
      const ep = /^\d+$/.test(String(this.opts.cdp)) ? `http://localhost:${this.opts.cdp}` : String(this.opts.cdp);
      try { this.browser = await pw.chromium.connectOverCDP(ep); }
      catch (e) {
        throw new EnvError(`Could not connect to Chrome over CDP at ${ep}.\nStart Chrome with a debugging port on a profile that is NOT already open, e.g.\n  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.scrape/real-chrome"\nthen re-run with --cdp 9222. (${String(e.message).split('\n')[0]})`);
      }
      this.cdp = true;
      this.context = this.browser.contexts()[0] || (await this.browser.newContext());
      try { await this.context.addInitScript({ content: HELPERS_SRC }); } catch { /* some CDP targets reject init scripts; inject() still covers each page */ }
      if (this.session?.cookies?.length) await this.context.addCookies(this.session.cookies).catch(() => {});
      this._page = this.context.pages()[0] || (await this.context.newPage());
      this._page.setDefaultTimeout(30_000);
      this.log(`browser: attached to your Chrome over CDP (${ep})`);
      return this._page;
    }
    const headless = !(this.opts.headful || this.opts['wait-for-human']);
    const profile = path.join(SCRAPE_HOME, 'profile');
    fs.mkdirSync(profile, { recursive: true });
    const tried = [];
    for (const channel of ['chrome', 'msedge', undefined]) {
      try {
        this.context = await pw.chromium.launchPersistentContext(profile, { channel, headless, viewport: { width: 1280, height: 900 } });
        this.log(`browser: ${channel || 'bundled chromium'} (${headless ? 'headless' : 'headful'})`);
        break;
      } catch (e) { tried.push(`${channel || 'bundled chromium'}: ${String(e.message).split('\n')[0]}`); }
    }
    if (!this.context) throw new EnvError(`No browser could be launched:\n  ${tried.join('\n  ')}\nFix: install Google Chrome, or run: cd "${SCRIPTS_DIR}" && npx playwright install chromium`);
    if (this.session?.cookies?.length) await this.context.addCookies(this.session.cookies);
    await this.restoreStorage();
    this._page = this.context.pages()[0] || (await this.context.newPage());
    this._page.setDefaultTimeout(30_000);
    await this._page.addInitScript({ content: HELPERS_SRC }); // future navigations; inject() covers the current document
    return this._page;
  }

  // A session export also holds localStorage, where SPAs keep the bearer token their API calls send. Put it
  // back before the page's own scripts run, once per tab and origin; after that the page owns it (tokens it
  // refreshes during the run are not overwritten). Own browser only — a --cdp browser is the user's.
  async restoreStorage() {
    const origins = (this.session?.origins || []).filter((o) => o.origin && o.localStorage?.length);
    if (!origins.length) return;
    await this.context.addInitScript((list) => {
      try {
        const mine = list.find((o) => o.origin === location.origin);
        if (!mine || sessionStorage.getItem('__scrape_ls')) return;
        for (const { name, value } of mine.localStorage) localStorage.setItem(name, value);
        sessionStorage.setItem('__scrape_ls', '1');
      } catch { /* storage unavailable (opaque origin) */ }
    }, origins);
  }

  async inject(page) { try { await page.evaluate(HELPERS_SRC); } catch { /* document still swapping; the init script will cover it */ } }

  async navigate(page, url, wait) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await this.inject(page);
      const humanHelped = await this.guard(page, resp ? resp.status() : undefined);
      // After a login or challenge the site often lands somewhere else; go back to the page we wanted once.
      if (humanHelped && attempt === 0 && page.url() !== url) continue;
      break;
    }
    await this.applyWait(page, wait);
  }

  async applyWait(page, wait) {
    if (!wait) return;
    const timeout = wait.timeout_ms ?? 15_000;
    try {
      if (wait.selector) await page.waitForSelector(wait.selector, { timeout, state: 'attached' });
      if (wait.network_idle) await page.waitForLoadState('networkidle', { timeout });
    } catch {
      this.log(`wait for ${wait.selector || 'network idle'} timed out after ${timeout} ms; extracting anyway`);
      await this.guard(page); // a challenge may have replaced the page while we waited
    }
  }

  async diagnose(page) {
    try { return await page.evaluate(() => window.__scrape.diagnose()); } catch { await this.inject(page); }
    try { return await page.evaluate(() => window.__scrape.diagnose()); } catch { return { blocked: false }; }
  }

  // Block / login check after every navigation. Returns true when a human cleared it.
  async guard(page, status) {
    // An HTTP error status on the navigation itself is a block the in-page text may not reveal
    // (e.g. Coupang serves a bare "쿠팡!" interstitial with a 403 and no vendor markers). Trust it, but
    // only for the first check — once a human acts, a fresh diagnose with no markers means it cleared.
    const statusKind = status === 429 ? 'rate_limited' : status === 403 || status === 503 ? 'access_denied' : null;
    const problem = (d) => (d.blocked ? 'blocked' : d.login_wall ? 'login_required' : null);
    let d = await this.diagnose(page);
    let why = problem(d) || (statusKind ? 'blocked' : null);
    if (!why) return false;
    const kind = why === 'login_required' ? 'login_required' : d.kind || statusKind || 'access_denied';
    const info = { vendor: d.vendor, kind, url: page.url(), status: status || undefined, signals: d.signals };
    // Only a challenge/login can be cleared by the person in the window. A hard denial — access_denied,
    // rate_limited, bot_page — is a flat "no": clicking cannot pass it, so waiting would just hold the
    // window open for nothing. Stop immediately and let the summary explain the honest options.
    if (!this.opts['wait-for-human'] || !SOLVABLE_BY_HUMAN.has(kind)) throw new BlockedError(why, info);
    console.error(why === 'blocked'
      ? `[collect] The site is asking for a human check (${d.vendor || 'unknown'} / ${kind}). Please complete it in the Chrome window; waiting up to 5 minutes…`
      : '[collect] The site is asking you to log in. Please log in in the Chrome window; waiting up to 5 minutes…');
    const deadline = Date.now() + HUMAN_WAIT_MS;
    while (Date.now() < deadline && !this.aborted) {
      await sleep(3000);
      d = await this.diagnose(page);
      if (!problem(d)) { console.error('[collect] Thanks — continuing.'); return true; }
    }
    throw new BlockedError(why, info);
  }

  async extractDom(page, fields, container) {
    await this.inject(page);
    const rows = await page.evaluate(([f, c]) => window.__scrape.extract(f, c), [fields, container || null]);
    return container ? rows : rows.filter(hasAnyValue); // no container = one row per page; an all-empty page counts as empty
  }

  // Always tear the browser down, even on an abnormal exit — a persistent context that is not closed
  // leaves a Chrome window on the user's screen. Idempotent so signal + finally can both call it.
  async close() {
    if (this._closed) return;
    this._closed = true;
    const ctx = this.context;
    const cdp = this.cdp;
    const browser = this.browser;
    this.context = null;
    this._page = null;
    this.browser = null;
    // --cdp: the browser is the user's own. Never close it or their tabs, and don't risk browser.close()
    // tearing it down — just drop the reference; the CDP socket closes when this process exits.
    if (cdp) { void browser; return; }
    if (!ctx) return;
    // close() can hang when a page is mid-navigation; bound it, then make sure the process is really gone.
    try { await Promise.race([ctx.close(), sleep(8000)]); } catch { /* already gone */ }
    try { await Promise.race([Promise.resolve(ctx.browser()?.close()), sleep(3000)]); } catch { /* no separate browser, or already closed */ }
    killOwnChrome();
  }

  // ---------- summary ----------
  summary() {
    const columns = this.columns || unionColumns(this.recipe.fields, this.recipe.detail?.fields, this.rows);
    const out = {
      ok: !this.error && !this.blockedBy,
      recipe: this.recipe.name,
      strategy: this.recipe.strategy,
      pages_done: this.pagesDone,
      rows: this.rows.length,
      output: this.dry ? null : this.flushed ? this.file : null,
      elapsed_ms: Date.now() - this.t0,
      stopped_reason: this.stop,
    };
    if (this.recipe.strategy === 'intercept') out.intercepted = this.responses;
    if (this.previousRows) out.rows_previous = this.previousRows;
    if (this.blockedBy) {
      out.blocked_by = this.blockedBy;
      const resume = this.flushed ? ' --resume' : '';
      if (SOLVABLE_BY_HUMAN.has(this.blockedBy.kind)) {
        out.hint = this.opts['wait-for-human']
          ? `The ${this.stop === 'login_required' ? 'login' : 'check'} was not completed in time. Re-run with --headful --wait-for-human${resume} and finish it in the Chrome window.`
          : `Re-run with --headful --wait-for-human${resume} and complete the ${this.stop === 'login_required' ? 'login' : 'check'} yourself in the Chrome window.`;
      } else {
        // Hard denial: a human cannot click past it, so do not suggest --wait-for-human.
        out.hint = `This site hard-blocks automated access (${this.blockedBy.vendor || 'unknown'} / ${this.blockedBy.kind}); a person cannot click past it. Try the site's official API/feed, a much slower rate, or collecting from your own already-open browser.`;
      }
    }
    if (this.error) out.error = this.error;
    out.fill_rate = fillRate(this.rows, columns);
    out.sample = this.rows.slice(0, this.dry ? 5 : 3).map(trimRow);
    return out;
  }

  printDryRun() {
    const columns = this.columns || unionColumns(this.recipe.fields, this.recipe.detail?.fields, this.rows);
    const fr = fillRate(this.rows, columns);
    console.error(`[collect] dry run: ${this.rows.length} rows from the first page; nothing written`);
    for (const r of this.rows.slice(0, 5)) console.error('  ' + JSON.stringify(trimRow(r)));
    console.error('[collect] fill rate: ' + columns.map((c) => `${c} ${Math.round(fr[c] * 100)}%`).join(' | '));
  }
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2), ARGS); } catch (e) { console.error(`[collect] ${e.message}\n${USAGE}`); return 1; }
  if (opts.help || !opts._[0]) { console.error(USAGE); return opts.help ? 0 : 1; }
  let recipe;
  try { ({ recipe } = loadRecipe(opts._[0])); } catch (e) {
    console.error(`[collect] ${e.message}`);
    console.log(JSON.stringify({ ok: false, recipe: opts._[0], error: e.message, stopped_reason: 'error' }));
    return 1;
  }
  const c = new Collector(recipe, opts);
  // On Ctrl-C / kill, close the browser before exiting so no Chrome window is left behind. The first
  // signal asks the run loop (and the wait-for-human loop) to stop; if cleanup stalls, a second forces exit.
  let shuttingDown = false;
  const onSignal = async (sig) => {
    if (shuttingDown) { if (!c.cdp) killOwnChrome(); process.exit(130); } // second signal: still never leave Chrome behind
    shuttingDown = true;
    c.aborted = true;
    console.error(`[collect] ${sig} — closing browser and saving what was collected…`);
    try { c.flush(); if (c.cursor) c.saveState(c.cursor); } catch { /* best effort */ }
    // A navigation in flight can make close() stall; give it 5 s, then kill our own browser outright.
    await Promise.race([c.close().catch(() => {}), sleep(5000)]);
    if (!c.cdp) killOwnChrome();
    process.exit(130);
  };
  process.on('SIGINT', () => { onSignal('interrupted'); });
  process.on('SIGTERM', () => { onSignal('terminated'); });
  let code = 0;
  try {
    await c.run();
  } catch (e) {
    if (e instanceof BlockedError) {
      c.stop = e.reason;
      c.blockedBy = e.info;
      c.flush();
      c.saveState(c.cursor, { blocked_by: e.info });
      c.log(`${e.reason === 'login_required' ? 'login required' : 'blocked'} at ${e.info.url}${e.info.vendor ? ` (${e.info.vendor} / ${e.info.kind})` : ''}`);
      code = 3;
    } else {
      c.stop = c.stop || 'error';
      c.error = e.message;
      c.flush();
      c.saveState(c.cursor, { error: e.message });
      console.error(`[collect] error: ${e.message}`);
      code = e.code || 1;
    }
  } finally {
    await c.close();
  }
  if (c.dry) c.printDryRun();
  const s = c.summary();
  if (!c.dry && !c.blockedBy && !c.error) c.log(`done: ${s.rows} rows → ${s.output || '(nothing written)'} (${s.stopped_reason})`);
  if (s.hint) console.error(`[collect] ${s.hint}`);
  console.log(JSON.stringify(s));
  return code;
}

main().then((code) => process.exit(code), (e) => { console.error(`[collect] fatal: ${e.stack || e}`); process.exit(1); });
