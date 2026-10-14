#!/usr/bin/env node
/*
 * har-scan.mjs — find the data API inside a HAR file the user saved from their own browser.
 *
 * When the MCP browser window is blocked but the user's own Chrome shows the page, a HAR export is the
 * "other door": it holds every request the page made, with response bodies. This ranks the JSON responses
 * that look like the data and prints what a recipe needs: URL pattern, paging/cursor parameter, the array
 * path, the item keys and a suggested strategy.
 *
 * A HAR is full of credentials. This tool prints header NAMES only and never a header, cookie or token
 * value, on stdout or stderr; query values that look like secrets are masked as {secret}.
 *
 * Details go to stderr; the LAST stdout line is one JSON summary. Exit 0 ok · 1 usage / unreadable file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, expandHome, jsonRows, tryParse, noiseRegex, shorten, UsageError } from './lib.mjs';

const USAGE = `usage: node har-scan.mjs <file.har> [--match "a value visible on the page"] [--limit 10]`;
const ARGS = { match: 'string', limit: 'number', help: 'boolean' };

const PAGE_NAME = /^(page|p|pg|pageno|pagenum|page_?no|page_?number|page_?index|current_?page|offset|start|skip|from)$/i;
const CURSOR_NAME = /^(cursor|after|before|next|next_?cursor|end_?cursor|next_?token|page_?token|next_?page_?token|continuation|continuation_?token|scroll_?id|since_?id|max_?id|marker|start_?after|starting_?after|last_?id|last_?key)$/i;
// Where a response says "continue here". Order = preference when several keys exist.
const NEXT_KEYS = [/^next_?cursor$/i, /^end_?cursor$/i, /^next_?page_?token$/i, /^next_?token$/i, /^continuation(_?token)?$/i, /^(next_?max_?id|scroll_?id|paging_?token|last_?evaluated_?key|last_?key)$/i, /^cursor$/i, /^(next|after)$/i];
const SECRET_NAME = /(^|[_-])(token|key|apikey|auth|authorization|sig|sign|signature|secret|session|sessionid|sid|password|passwd|pwd|jwt|credential|hmac|nonce|csrf|xsrf|ticket)([_-]|$)|(token|key|secret|signature)$/i;
const BORING_HEADER = /^(:.*|accept|accept-encoding|accept-language|user-agent|connection|host|content-length|cache-control|pragma|dnt|priority|te|upgrade-insecure-requests|sec-.*|if-none-match|if-modified-since|range)$/i;
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey)$|token|auth|csrf|xsrf|session/i;
// A header the page computes per request or per session. It cannot be copied into a recipe for long.
const COMPUTED_HEADER = /sign|hmac|nonce|sensor|timestamp|x-ts$|x-kpsdk|x-px|x-acf|x-bm|challenge|fingerprint|x-csrf|xsrf/i;
const ANTIBOT_COOKIE = /^(_abck|bm_sz|ak_bmsc|cf_clearance|__cf_bm|datadome|_px\d?|_pxhd|_pxvid|incap_ses_.*|visid_incap_.*|reese84|KP_UIDz.*)$/i;

const looksSecret = (v) => /^eyJ[\w-]+\./.test(v) || (v.length >= 20 && !/\s/.test(v) && /[A-Za-z]/.test(v) && /\d/.test(v));
const idSegment = (s) => /^\d+$/.test(s) || /^(?=.*\d)[0-9a-f]{8,}$/i.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || looksSecret(s);
const simpleKey = (k) => /^[\w$-]+$/.test(k); // keys the getPath grammar can address
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// "39,000원" should find 39000 in the JSON, the same way findByText does on the page.
function matcher(q) {
  if (!q) return null;
  const needle = q.toLowerCase();
  const digits = q.replace(/[^\d]/g, '');
  const numeric = digits.length >= 2 && digits.length >= q.replace(/\s/g, '').length * 0.5;
  const num = numeric ? new RegExp(`(?<![\\d.])${digits}(?!\\d)`) : null;
  return (text) => text.toLowerCase().includes(needle) || (num ? num.test(text) : false);
}

// Response body → { state, json }. Chrome stores binary or non-UTF-8 bodies as base64 and drops bodies it
// evicted from memory (content.text missing), so "empty" does not mean the API returned nothing.
export function responseBody(entry) {
  const c = entry?.response?.content || {};
  if (typeof c.text !== 'string' || c.text === '') return { state: 'empty' };
  let text = c.text;
  if (c.encoding === 'base64') text = Buffer.from(c.text, 'base64').toString('utf8');
  text = text.replace(/^﻿/, '').replace(/^(\)\]\}',?|for\s*\(;;\);|while\s*\(1\);)\s*/, ''); // anti-JSON-hijacking prefixes
  const json = tryParse(text);
  if (json === undefined || json === null || typeof json !== 'object') return { state: 'not_json' };
  return { state: c.encoding === 'base64' ? 'base64' : 'json', json };
}

// Every array of objects in a document, as an items.path in the collector's grammar ("data.items[]", "[]").
export function objectArrays(json) {
  const out = [];
  const walk = (v, p, depth) => {
    if (depth > 6 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      const here = `${p}[]`;
      const objs = v.filter(isObj);
      if (objs.length && objs.length >= v.length / 2) out.push(here);
      if (isObj(v[0])) walk(v[0], here, depth + 1); // lists inside list items: "groups[].items[]"
      return;
    }
    for (const [k, x] of Object.entries(v).slice(0, 200)) if (x && typeof x === 'object' && simpleKey(k)) walk(x, p ? `${p}.${k}` : k, depth + 1);
  };
  walk(json, '', 0);
  return out;
}

// First key path whose name says "next cursor", breadth-first so "next_cursor" beats "items[0].cursor".
function findKey(json, tests, maxDepth = 5) {
  for (const re of tests) {
    let level = [[json, '']];
    for (let d = 0; d <= maxDepth && level.length; d++) {
      const next = [];
      for (const [v, p] of level) {
        if (!isObj(v)) continue;
        for (const [k, x] of Object.entries(v).slice(0, 200)) {
          if (!simpleKey(k)) continue;
          const kp = p ? `${p}.${k}` : k;
          if (re.test(k) && (x === null || typeof x !== 'object')) return { path: kp, value: x };
          if (isObj(x)) next.push([x, kp]);
        }
      }
      level = next;
    }
  }
  return null;
}

function describeRequest(entry, noise) {
  const req = entry.request || {};
  let u;
  try { u = new URL(req.url); } catch { return null; }
  const method = String(req.method || 'GET').toUpperCase();
  const segs = u.pathname.split('/').map((s) => (s && idSegment(safeDecode(s)) ? '{id}' : s));
  const masked = [];
  let pageParam = null;
  let cursorParam = null;
  const query = [];
  for (const [k, v] of u.searchParams) {
    // cursor before secret: "page_token" / "nextToken" are cursors, and either way the value is not printed
    if (CURSOR_NAME.test(k) && !/^\d{1,6}$/.test(v)) { cursorParam = cursorParam || { in: 'query', name: k }; query.push(`${k}={cursor}`); }
    else if (PAGE_NAME.test(k) && /^\d+$/.test(v)) { pageParam = pageParam || { in: 'query', name: k }; query.push(`${k}={n}`); }
    else if (SECRET_NAME.test(k) || looksSecret(v)) { masked.push(k); query.push(`${k}={secret}`); }
    else query.push(`${k}=${shorten(v, 40)}`);
  }
  // POST bodies: GraphQL variables and JSON search payloads carry the page or cursor.
  const post = tryParse(req.postData?.text || '');
  let operation = u.searchParams.get('operationName') || null;
  if (isObj(post)) {
    if (typeof post.operationName === 'string') operation = post.operationName;
    const c = findKey(post, [CURSOR_NAME], 3);
    if (c && !cursorParam && typeof c.value !== 'number') cursorParam = { in: 'body', name: c.path };
    const p = findKey(post, [PAGE_NAME], 3);
    if (p && !pageParam && typeof p.value === 'number') pageParam = { in: 'body', name: p.path };
  }
  const names = [...new Set((req.headers || []).map((h) => String(h.name || '').toLowerCase()).filter((n) => n && !BORING_HEADER.test(n)))];
  const cookieNames = (req.cookies || []).map((c) => String(c.name || ''));
  return {
    method,
    host: u.host,
    url_pattern: `${u.protocol}//${u.host}${segs.join('/')}${query.length ? '?' + query.join('&') : ''}`,
    // one candidate per endpoint: same method + path shape + parameter names (+ GraphQL operation)
    key: [method, u.host, segs.join('/'), [...u.searchParams.keys()].sort().join(','), operation || ''].join(' '),
    operation: operation && /^[\w.-]{1,80}$/.test(operation) ? operation : null,
    pageParam,
    cursorParam,
    masked,
    headers: names,
    credentials: names.filter((n) => CREDENTIAL_HEADER.test(n)),
    computed: names.filter((n) => COMPUTED_HEADER.test(n)),
    antibot: [...new Set(cookieNames.filter((n) => ANTIBOT_COOKIE.test(n)))],
    noise: noise.test(u.host + u.pathname),
    haystack: safeDecode(req.url) + '\n' + (req.postData?.text || ''), // private: only used to confirm a cursor round-trip
  };
}
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

export function scanHar(har, { match, limit = 10 } = {}) {
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw new UsageError('not a HAR file: log.entries is missing');
  const noise = noiseRegex();
  const hit = matcher(match);
  const groups = new Map();
  let jsonResponses = 0;
  let anyCredentialHeader = false;
  for (const entry of entries) {
    const headerNames = (entry?.request?.headers || []).map((h) => String(h.name || '').toLowerCase());
    if (headerNames.includes('cookie') || headerNames.includes('authorization') || (entry?.request?.cookies || []).length) anyCredentialHeader = true;
    const mime = String(entry?.response?.content?.mimeType || '');
    const body = responseBody(entry);
    if (body.state === 'not_json' || (body.state === 'empty' && !/json/i.test(mime))) continue;
    const req = describeRequest(entry, noise);
    if (!req) continue;
    jsonResponses++;
    const status = entry.response?.status ?? 0;
    const cand = { req, status, body: body.state, score: 0, rows: 0, items_path: null, item_keys: [], other_arrays: [], matched: false, next: null };
    if (body.json) {
      const text = JSON.stringify(body.json);
      cand.matched = hit ? hit(text) : false;
      // Rank the arrays with the collector's own jsonRows, so the path printed here is one a recipe can use as is.
      const arrays = objectArrays(body.json).map((p) => {
        const rows = jsonRows(body.json, { path: p }, {});
        const keys = isObj(rows[0]) ? Object.keys(rows[0]) : [];
        const inRows = hit ? hit(JSON.stringify(rows)) : false;
        return { path: p, rows: rows.length, keys, inRows, weight: Math.min(rows.length, 50) + Math.min(keys.length, 10) + (inRows ? 100 : 0) };
      }).filter((a) => a.rows).sort((a, b) => b.weight - a.weight);
      if (arrays.length) {
        const best = arrays[0];
        cand.items_path = best.path;
        cand.rows = best.rows;
        cand.item_keys = best.keys.slice(0, 25);
        cand.other_arrays = arrays.slice(1, 3).map((a) => `${a.path} (${a.rows})`);
        cand.score += 50 + Math.min(best.rows, 50) + Math.min(best.keys.length, 10) + (best.inRows ? 20 : 0);
      }
      if (cand.matched) cand.score += 40;
      cand.next = findKey(body.json, NEXT_KEYS);
    } else cand.score -= 40; // body was not saved in the HAR
    if (req.noise) cand.score -= 80;
    if (status < 200 || status >= 300) cand.score -= 30;
    if (/^(xhr|fetch)$/i.test(entry._resourceType || '')) cand.score += 5;
    const g = groups.get(req.key) || { best: null, all: [] };
    g.all.push(cand);
    if (!g.best || cand.score > g.best.score) g.best = cand;
    groups.set(req.key, g);
  }

  const candidates = [...groups.values()].map((g) => {
    const c = g.best;
    const r = c.req;
    const score = c.score + Math.min(g.all.length - 1, 5) * 3; // called repeatedly = probably the paged list
    // Cursor evidence: a value some response returned shows up in another request to the same endpoint.
    const nexts = g.all.map((x) => x.next).filter((n) => n && n.value != null && n.value !== '');
    const next = c.next || g.all.map((x) => x.next).find(Boolean) || null;
    const nextIsUrl = nexts.some((n) => /^https?:\/\//i.test(String(n.value)));
    const confirmed = nexts.some((n) => String(n.value).length >= 2 && g.all.some((x) => x.req.haystack.includes(String(n.value))));
    const cursorParam = g.all.map((x) => x.req.cursorParam).find(Boolean) || null;
    const pageParam = g.all.map((x) => x.req.pageParam).find(Boolean) || null;
    const cursor = !nextIsUrl && next && (cursorParam || confirmed);
    const pages = cursor ? 'cursor' : pageParam ? 'param' : 'single';
    const guarded = r.computed.length || r.antibot.length;
    const why = [];
    if (r.computed.length) why.push(`headers the page computes (${r.computed.join(', ')})`);
    if (r.antibot.length) why.push(`anti-bot cookies (${r.antibot.join(', ')})`);
    if (!guarded && r.credentials.length) why.push(`sent with credentials (${r.credentials.join(', ')}): try http with the exported session and confirm with probe-http, else intercept`);
    if (!guarded && !r.credentials.length) why.push('no credentials or computed headers seen: confirm with probe-http');
    if (cursor) why.push(`cursor ${confirmed ? 'round-trip seen' : 'suspected'}: response ${next.path} → request ${cursorParam ? `${cursorParam.in} ${cursorParam.name}` : 'parameter'}`);
    if (nextIsUrl) why.push(`response ${next.path} is a full next-page URL, not a cursor value: use intercept with scroll/next_link`);
    const out = {
      score,
      method: r.method,
      url_pattern: r.url_pattern,
      status: c.status,
      calls: g.all.length,
      body: c.body,
      items_path: c.items_path,
      rows: c.rows,
      item_keys: c.item_keys,
      paging: {
        page_param: pageParam ? `${pageParam.in}:${pageParam.name}` : null,
        cursor_param: cursorParam ? `${cursorParam.in}:${cursorParam.name}` : null,
        cursor_path: next && !nextIsUrl ? next.path : null,
        cursor_confirmed: !!cursor && confirmed,
      },
      headers: r.headers,
      recommend: { strategy: guarded || nextIsUrl ? 'intercept' : 'http', pages: nextIsUrl ? 'scroll' : pages, why: why.join('; ') },
    };
    if (hit) out.match = g.all.some((x) => x.matched);
    if (c.other_arrays.length) out.other_arrays = c.other_arrays;
    if (r.operation) out.graphql_operation = r.operation;
    if (r.masked.length) out.masked_params = [...new Set(r.masked)];
    if (r.antibot.length) out.antibot_cookies = r.antibot;
    if (r.noise) out.noise = true;
    return out;
  }).sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit)).map((c, i) => ({ rank: i + 1, ...c }));

  const summary = { ok: true, entries: entries.length, json_responses: jsonResponses, candidates };
  if (match) summary.match = { query: match, found: candidates.some((c) => c.match) };
  if (!anyCredentialHeader) {
    summary.credentials_absent = true;
    summary.note = 'No Cookie or Authorization header anywhere in this HAR. Chrome\'s default export is sanitized and strips them, so an endpoint may still need a login/session; if probe-http is refused, ask for "Export HAR (with sensitive data)" or use intercept.';
  }
  return summary;
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2), ARGS); } catch (e) { console.error(`[har-scan] ${e.message}\n${USAGE}`); return 1; }
  if (opts.help || !opts._[0]) { console.error(USAGE); return opts.help ? 0 : 1; }
  const file = path.resolve(expandHome(opts._[0]));
  const fail = (error) => { console.error(`[har-scan] ${error}`); console.log(JSON.stringify({ ok: false, file, error })); return 1; };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return fail(`cannot read the file (${e.code || 'error'})`); }
  // No e.message here: Node quotes a slice of the input in JSON errors, and the input is full of credentials.
  const har = tryParse(text.replace(/^﻿/, ''));
  if (har === undefined) return fail('the file is not valid JSON (a HAR is a JSON file; was the download cut short?)');
  let summary;
  try { summary = scanHar(har, { match: opts.match, limit: opts.limit ?? 10 }); } catch (e) { if (e instanceof UsageError) return fail(e.message); throw e; }
  console.error(`[har-scan] ${summary.entries} requests, ${summary.json_responses} JSON responses, ${summary.candidates.length} candidates shown`);
  for (const c of summary.candidates) {
    console.error(`\n#${c.rank}  score ${c.score}  ${c.method} ${c.url_pattern}${c.graphql_operation ? `  [${c.graphql_operation}]` : ''}${c.noise ? '  (tracker/ads domain)' : ''}`);
    console.error(`    status ${c.status} · ${c.calls} call(s) · body ${c.body}${c.match !== undefined ? ` · match ${c.match ? 'yes' : 'no'}` : ''}`);
    console.error(c.items_path ? `    items.path ${c.items_path}  (${c.rows} rows)  keys: ${c.item_keys.join(', ')}` : '    no array of objects in the saved body');
    const pg = c.paging;
    if (pg.page_param || pg.cursor_param || pg.cursor_path) console.error(`    paging: ${[pg.page_param && `page ${pg.page_param}`, pg.cursor_param && `cursor ${pg.cursor_param}`, pg.cursor_path && `next cursor at ${pg.cursor_path}${pg.cursor_confirmed ? ' (round-trip seen)' : ''}`].filter(Boolean).join(' · ')}`);
    if (c.headers.length) console.error(`    header names: ${c.headers.join(', ')}`);
    console.error(`    → ${c.recommend.strategy}${c.recommend.pages !== 'single' ? ` + pages.type ${c.recommend.pages}` : ''}: ${c.recommend.why}`);
  }
  if (summary.note) console.error(`\n[har-scan] ${summary.note}`);
  console.log(JSON.stringify({ ok: true, file, ...summary }));
  return 0;
}

// Run only as a script, so selftest can import scanHar without side effects.
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) process.exit(main());
