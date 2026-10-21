/*
 * lib.mjs — pieces shared by collect.mjs, probe-http.mjs and doctor.mjs.
 * Keep Node-only here; anything that must also run in the page lives in page/helpers.js.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const SCRIPTS_DIR = fileURLToPath(new URL('.', import.meta.url));
export const HELPERS_PATH = path.join(SCRIPTS_DIR, 'page', 'helpers.js');
export const SCRAPE_HOME = path.join(os.homedir(), '.scrape');
export const PAGE_TYPES = ['single', 'urls', 'param', 'next_link', 'scroll', 'cursor', 'next_url'];
export const STRATEGIES = ['dom', 'http', 'embedded', 'intercept'];
export const FORMATS = ['csv', 'json', 'jsonl'];

// Exit codes are part of the contract with the model that calls these scripts.
export class UsageError extends Error { code = 1; }
export class EnvError extends Error { code = 2; }
export class BlockedError extends Error {
  code = 3;
  constructor(reason, info) { super(reason === 'login_required' ? 'login required' : 'blocked by bot protection'); this.reason = reason; this.info = info; }
}

export const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
export const hasAnyValue = (row) => Object.values(row || {}).some((v) => !isEmpty(v));
export const shorten = (s, n = 80) => (s && s.length > n ? s.slice(0, n) + '…' : s);
// Local calendar date as YYYYMMDD for file names. toISOString() is UTC, which is still "yesterday"
// before 09:00 KST and produced coupang-498919-20261007.csv at 08:41 on the 8th.
export const localDate = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
export const tryParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

// Random delay around rate.delay_ms so request timing does not look like a metronome.
export function jittered(rate = {}) {
  const d = rate.delay_ms ?? 1500;
  const j = rate.jitter_ms ?? 500;
  return Math.max(0, Math.round(d + (Math.random() * 2 - 1) * j));
}

// Tiny argv parser: spec = { name: 'boolean' | 'number' | 'string' }. Accepts --k v and --k=v.
export function parseArgs(argv, spec) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    let val = eq === -1 ? undefined : a.slice(eq + 1);
    const type = spec[key];
    if (!type) throw new UsageError(`unknown option --${key}`);
    if (type === 'boolean') { out[key] = val === undefined ? true : val !== 'false'; continue; }
    if (val === undefined) val = argv[++i];
    if (val === undefined) throw new UsageError(`--${key} needs a value`);
    out[key] = type === 'number' ? Number(val) : val;
    if (type === 'number' && !Number.isFinite(out[key])) throw new UsageError(`--${key} must be a number`);
  }
  return out;
}

// ---------- recipes ----------
export function resolveRecipePath(arg) {
  if (/\.json$/i.test(arg) || arg.includes('/') || arg.includes('\\')) return path.resolve(expandHome(arg));
  return path.join(SCRAPE_HOME, 'recipes', `${arg}.json`);
}

export function loadRecipe(arg) {
  const file = resolveRecipePath(arg);
  if (!fs.existsSync(file)) throw new UsageError(`recipe not found: ${file}`);
  let recipe;
  try { recipe = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new UsageError(`recipe is not valid JSON (${file}): ${e.message}`); }
  validateRecipe(recipe);
  return { recipe, file };
}

// Validate up front so a typo fails in milliseconds instead of after a browser launch.
export function validateRecipe(r) {
  const fail = (m) => { throw new UsageError(`recipe error: ${m}`); };
  if (!r || typeof r !== 'object') fail('recipe must be a JSON object');
  if (r.version !== 1) fail('"version" must be 1');
  if (!r.name || !/^[a-z0-9][a-z0-9._-]*$/i.test(r.name)) fail('"name" must be a kebab-case identifier (letters, digits, - _ .)');
  if (!STRATEGIES.includes(r.strategy)) fail('"strategy" must be dom, http, embedded or intercept');
  const inBrowser = r.strategy === 'dom' || r.strategy === 'intercept'; // these two drive a real page
  const p = r.pages;
  if (!p || !PAGE_TYPES.includes(p.type)) fail(`"pages.type" must be one of ${PAGE_TYPES.join(', ')}`);
  if (p.type === 'urls' && !(Array.isArray(p.urls) && p.urls.length)) fail('"pages.urls" must be a non-empty array');
  if (['single', 'next_link', 'scroll'].includes(p.type) && !p.start) fail(`"pages.start" is required for pages.type ${p.type}`);
  if (p.type === 'next_link' && !p.next_selector) fail('"pages.next_selector" is required for pages.type next_link');
  if (['next_link', 'scroll'].includes(p.type) && !inBrowser) fail(`pages.type ${p.type} only works with strategy dom or intercept`);
  if (p.type === 'cursor') {
    if (!['http', 'intercept'].includes(r.strategy)) fail('pages.type cursor only works with strategy http or intercept');
    if (!p.cursor_path || typeof p.cursor_path !== 'string') fail('"pages.cursor_path" (where the response carries the next cursor) is required for pages.type cursor');
    if (r.strategy === 'intercept' && !p.start) fail('"pages.start" is required for pages.type cursor with strategy intercept');
    if (r.strategy === 'http') {
      if (!r.http?.url_template) fail('"http.url_template" is required for pages.type cursor');
      if (!r.http.url_template.includes('{cursor}') && !JSON.stringify(r.http.body ?? '').includes('{cursor}')) fail('"http.url_template" or "http.body" must contain {cursor}');
    }
  }
  if (p.type === 'next_url') {
    if (!['http', 'embedded'].includes(r.strategy)) fail('pages.type next_url only works with strategy http or embedded');
    if (!p.next_url_path || typeof p.next_url_path !== 'string') fail('"pages.next_url_path" (where the response carries the next page\'s URL) is required for pages.type next_url');
    if (!(p.start || r.http?.url_template)) fail('"pages.start" (the first URL) is required for pages.type next_url');
  }
  if (p.type === 'param') {
    const tmpl = r.strategy === 'http' ? r.http?.url_template || p.template : p.template;
    if (!tmpl || !tmpl.includes('{n}')) fail(r.strategy === 'http' ? '"http.url_template" (or "pages.template") must contain {n}' : '"pages.template" must contain {n}');
  }
  if (!r.fields || typeof r.fields !== 'object') fail('"fields" is required');
  if (r.strategy === 'http' && !(r.http?.url_template || p.template || p.urls || p.start)) fail('"http.url_template" is required for strategy http');
  if (r.strategy === 'embedded' && !r.embedded?.source) fail('"embedded.source" is required for strategy embedded');
  if (r.strategy === 'intercept') {
    const m = r.intercept?.url_match;
    if (!m || typeof m !== 'string') fail('"intercept.url_match" (a regex tested against response URLs) is required for strategy intercept');
    try { new RegExp(m); } catch (e) { fail(`"intercept.url_match" is not a valid regex: ${e.message}`); }
    if (r.intercept.channel != null && !['http', 'websocket', 'sse'].includes(r.intercept.channel)) fail('"intercept.channel" must be http, websocket or sse');
    const w = r.intercept.where;
    if (w != null && (typeof w !== 'object' || Array.isArray(w) || !Object.keys(w).length)) fail('"intercept.where" must be an object of { "path": value or [values] }');
    const br = r.intercept.binary_records;
    if (br != null && !(br && [1, 2, 4].includes(br.length_bytes) && (br.type_bytes ?? 0) >= 0 && (br.type_bytes ?? 0) <= 4)) fail('"intercept.binary_records" must be { "length_bytes": 1|2|4, "type_bytes": 0-4 }');
    if (r.intercept.channel && r.intercept.channel !== 'http' && p.type === 'cursor') fail('pages.type cursor reads responses; it does not work with intercept.channel websocket/sse');
  }
  if (r.detail) {
    if (!r.detail.url_field) fail('"detail.url_field" is required');
    if (!r.detail.fields || typeof r.detail.fields !== 'object') fail('"detail.fields" is required');
    if (r.detail.strategy === 'embedded' && !(r.detail.embedded?.source || r.embedded?.source)) fail('"detail.embedded.source" is required when detail.strategy is embedded');
  }
  for (const [where, fields] of [['fields', r.fields], ['detail.fields', r.detail?.fields]]) {
    for (const [n, f] of Object.entries(fields || {})) {
      if (f?.template == null) continue;
      if (typeof f.template !== 'string') fail(`"${where}.${n}.template" must be a string such as "https://site/item/{id}"`);
      const known = new Set([...Object.keys(r.fields), ...Object.keys(r.detail?.fields || {})]);
      for (const [, k] of f.template.matchAll(/\{([^{}]+)\}/g)) if (!known.has(k)) fail(`"${where}.${n}.template" uses {${k}}, which is not a column of this recipe`);
    }
  }
  const req = r.items?.require;
  if (req != null && !(Array.isArray(req) && req.every((k) => typeof k === 'string' && k in r.fields))) fail('"items.require" must be a list of column names from "fields"');
  if (r.detail?.strategy != null && !['dom', 'embedded', 'http'].includes(r.detail.strategy)) fail('"detail.strategy" must be dom, embedded or http');
  if (r.output?.format && !FORMATS.includes(r.output.format)) fail(`"output.format" must be one of ${FORMATS.join(', ')}`);
}

// ---------- HTTP ----------
const CHROME = '141.0.0.0';
const UA = {
  darwin: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME} Safari/537.36`,
  win32: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME} Safari/537.36`,
  linux: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME} Safari/537.36`,
};
// kind: 'json' for API endpoints, 'html' for pages, 'any' for probing an unknown URL.
export function defaultHeaders(kind = 'json') {
  const accept = kind === 'html' ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    : kind === 'any' ? 'application/json, text/html, text/plain, */*'
    : 'application/json, text/plain, */*';
  return { 'user-agent': UA[process.platform] || UA.linux, accept, 'accept-language': 'en-US,en;q=0.9' };
}

// Later sets win; keys are lower-cased so a recipe's "User-Agent" replaces the default "user-agent".
export function mergeHeaders(...sets) {
  const out = {};
  for (const s of sets) for (const [k, v] of Object.entries(s || {})) if (v != null) out[k.toLowerCase()] = String(v);
  return out;
}

// Playwright storageState ({ cookies, origins }) or a bare cookie array. `origins` carries each origin's
// localStorage, which the collector's browser restores (http/embedded only ever use the cookies).
export function loadStorageState(file) {
  if (!file) return null;
  const p = expandHome(file);
  if (!fs.existsSync(p)) throw new UsageError(`session.cookies_file not found: ${p}`);
  const s = tryParse(fs.readFileSync(p, 'utf8'));
  if (!s) throw new UsageError(`session.cookies_file is not valid JSON: ${p}`);
  return { cookies: Array.isArray(s) ? s : s.cookies || [], origins: Array.isArray(s) ? [] : s.origins || [] };
}

// Cookie header for one request: only cookies whose domain/path/secure/expiry fit the URL, like a browser would send.
export function cookieHeader(cookies, url) {
  const u = new URL(url);
  const now = Date.now() / 1000;
  const ok = (cookies || []).filter((c) => {
    if (!c.name) return false;
    const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
    if (d && u.hostname !== d && !u.hostname.endsWith('.' + d)) return false;
    if (c.path && c.path !== '/' && !u.pathname.startsWith(c.path)) return false;
    if (c.secure && u.protocol !== 'https:') return false;
    if (typeof c.expires === 'number' && c.expires > 0 && c.expires < now) return false;
    return true;
  });
  return ok.length ? ok.map((c) => `${c.name}=${c.value}`).join('; ') : null;
}

// Challenge pages that come back with a 200 still need to be recognised. Only HTML bodies are scanned,
// so a JSON row that happens to contain "Access Denied" is not mistaken for a block.
const MARKERS = [
  [/just a moment/i, 'cloudflare', 'js_challenge', 'title "Just a moment"', 'title'],
  [/attention required/i, 'cloudflare', 'access_denied', 'title "Attention Required"', 'title'],
  [/access denied/i, null, 'access_denied', 'title "Access Denied"', 'title'],
  [/pardon our interruption/i, 'imperva', 'bot_page', '"Pardon Our Interruption"', 'title'],
  [/verify you are human/i, 'cloudflare', 'turnstile', '"verify you are human"', 'body'],
  [/challenges\.cloudflare\.com/i, 'cloudflare', 'turnstile', 'turnstile script', 'body'],
  [/captcha-delivery\.com/i, 'datadome', 'captcha', 'captcha-delivery', 'body'],
  [/_Incapsula_Resource/i, 'imperva', 'js_challenge', '_Incapsula_Resource', 'body'],
  [/px-captcha/i, 'human', 'captcha', 'px-captcha', 'body'],
];
export function detectBlockedHttp(status, headers, text) {
  const h = (k) => (headers && typeof headers.get === 'function' ? headers.get(k) : headers?.[k]) || '';
  const server = h('server').toLowerCase();
  let vendor = server.includes('cloudflare') || h('cf-ray') ? 'cloudflare'
    : h('x-datadome') || h('x-dd-b') ? 'datadome'
    : h('x-iinfo') || /incapsula/i.test(h('x-cdn')) ? 'imperva'
    : server.includes('akamai') || h('x-akamai-transformed') ? 'akamai'
    : null;
  const signals = [];
  let kind = null;
  if (status === 403) { kind = 'access_denied'; signals.push('http 403'); }
  else if (status === 429) { kind = 'rate_limited'; signals.push('http 429'); }
  else if (status === 503) { kind = vendor === 'cloudflare' ? 'js_challenge' : 'unavailable'; signals.push('http 503'); }
  if (/^\s*(<!doctype|<html|<head|<\?xml|<script)/i.test(text || '')) {
    const head = text.slice(0, 200_000);
    const title = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    for (const [re, v, k, label, scope] of MARKERS) {
      if (!re.test(scope === 'title' ? title : head)) continue;
      signals.push(label);
      vendor = vendor || v;
      kind = kind || k;
    }
  }
  return { blocked: !!kind, vendor: kind ? vendor || 'unknown' : vendor, kind, signals };
}

// Tracker / ads / analytics hosts. page/helpers.js is browser-only and cannot be imported, so its NOISE
// literal is read from the source instead of keeping a second copy here that would drift.
export function noiseRegex() {
  const m = fs.readFileSync(HELPERS_PATH, 'utf8').match(/const NOISE = \/(.+)\/([a-z]*);/);
  if (!m) throw new Error('NOISE regex not found in page/helpers.js');
  return new RegExp(m[1], m[2]);
}

// ---------- JSON paths and fields (grammar identical to page/helpers.js getPath) ----------
// "[]" on a single object treats it as a one-item list: APIs (and schema-less protobuf, where a repeated field
// seen once is not an array) often send one item without the array around it.
// ["routes/kr.search._index"] (or ['…']) addresses a key that holds dots or brackets; \" and \\ escape inside.
const ITER = Symbol('[]');
export function pathSegments(p) {
  const segs = [];
  const re = /\[\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*\]|\[(\d+)\]|\[\]|([^.[\]]+)/g;
  for (const m of p.matchAll(re)) {
    if (m[1]) segs.push(m[2].replace(/\\(.)/g, '$1'));
    else if (m[3] !== undefined) segs.push(m[3]);
    else if (m[4] !== undefined) segs.push(m[4]);
    else segs.push(ITER);
  }
  return segs;
}
export function getPath(obj, p) {
  if (!p || p === '$') return obj;
  return walkPath(obj, pathSegments(p));
}
function walkPath(obj, segs) {
  let cur = obj;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (cur == null) return undefined;
    if (s === ITER) {
      const rest = segs.slice(i + 1);
      return Array.isArray(cur) ? cur.map((x) => walkPath(x, rest)) : typeof cur === 'object' ? [walkPath(cur, rest)] : undefined;
    }
    cur = cur[s];
  }
  return cur;
}

// One column from one JSON row. Mirrors value() in helpers.js: regex (group 1 wins), then transform.
export function jsonField(row, raw) {
  const spec = typeof raw === 'string' ? { path: raw } : raw || {};
  if (spec.template != null) return null; // filled from the other columns by finishRows
  let v = getPath(row, spec.path ?? spec.selector ?? '');
  if (v === undefined) v = null;
  // transform: "count" — how many, not which: array length (a missing value counts 0, a single value 1)
  if (spec.transform === 'count') return Array.isArray(v) ? v.length : v == null ? 0 : 1;
  if (spec.regex && v != null) {
    const m = String(v).match(new RegExp(spec.regex, spec.regex_flags || ''));
    v = m ? (m[1] !== undefined ? m[1] : m[0]) : null;
  }
  // map: { "One": 1, "Two": 2 } — star ratings in class names, status words, etc. Unknown values pass through.
  if (spec.map && v != null && Object.prototype.hasOwnProperty.call(spec.map, String(v))) v = spec.map[String(v)];
  if (v != null && spec.transform === 'number') {
    const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
    v = Number.isNaN(n) ? null : n;
  }
  if (v != null && spec.transform === 'trim') v = String(v).replace(/\s+/g, ' ').trim();
  return v;
}

// data -> rows. items.path picks the array ("quotes[]"); no items = the whole document is one row.
// Empty fields = keep the row's own top-level keys, handy for "just give me the API rows as a table".
export function jsonRows(data, items, fields) {
  const p = items?.path;
  let rows = p ? getPath(data, p) : data;
  if (rows == null) return [];
  const iterations = p ? pathSegments(p).filter((x) => x === ITER).length : 0;
  rows = Array.isArray(rows) ? (iterations > 1 ? rows.flat(iterations - 1) : rows) : [rows];
  const names = Object.keys(fields || {});
  return rows
    .filter((r) => r != null)
    .map((r) => (names.length ? Object.fromEntries(names.map((n) => [n, jsonField(r, fields[n])])) : r && typeof r === 'object' && !Array.isArray(r) ? r : { value: r }))
    .filter(hasAnyValue);
}

// ---------- finishing rows: columns computed after extraction ----------
// template: "https://n.news.naver.com/article/{언론사ID}/{기사ID}" builds a column from the row's other columns
// (empty if any placeholder is empty). absolute: true resolves a relative URL against base; a string is its own base
// (dom fields already resolve href/src in the page). require: ["순위"] drops rows missing those columns (banners, ads).
export function fillTemplate(tmpl, row) {
  let missing = false;
  const out = tmpl.replace(/\{([^{}]+)\}/g, (_, k) => {
    if (isEmpty(row[k])) { missing = true; return ''; }
    return String(row[k]);
  });
  return missing ? null : out;
}

export function finishRows(rows, fields, { base, require } = {}) {
  const specs = Object.entries(fields || {}).filter(([, raw]) => raw && typeof raw === 'object');
  for (const row of rows) {
    for (const [n, s] of specs) {
      if (!s.absolute || typeof row[n] !== 'string' || !row[n]) continue;
      try { row[n] = new URL(row[n], typeof s.absolute === 'string' ? s.absolute : base).href; } catch { /* leave as is */ }
    }
    for (const [n, s] of specs) if (typeof s.template === 'string') row[n] = fillTemplate(s.template, row);
  }
  return require?.length ? rows.filter((r) => require.every((k) => !isEmpty(r[k]))) : rows;
}

// ---------- cursor pagination and request templates ----------
// "{cursor}" in a URL template. An empty cursor (the first page) drops the whole query parameter, because
// "?after=" is an error on many APIs.
export function cursorUrl(tmpl, cursor) {
  if (!isEmpty(cursor)) return tmpl.replaceAll('{cursor}', encodeURIComponent(String(cursor)));
  return tmpl
    .replace(/([?&])[^=&#?]+=\{cursor\}(&?)/g, (m, lead, trail) => (trail ? lead : ''))
    .replaceAll('{cursor}', '');
}

// "{n}" / "{cursor}" inside http.body. In an object body a value that is exactly the placeholder keeps a JSON
// type: {n} becomes a number and an empty {cursor} becomes null (GraphQL's `after: null`). A string body is
// treated as text: JSON-escaped when it looks like JSON, URL-encoded otherwise (form posts).
export function fillBody(body, vars = {}) {
  const hasCursor = 'cursor' in vars;
  const cursor = isEmpty(vars.cursor) ? '' : String(vars.cursor);
  const text = (s, enc) => {
    if (hasCursor) s = s.replaceAll('{cursor}', enc(cursor));
    if (vars.n != null) s = s.replaceAll('{n}', String(vars.n));
    return s;
  };
  if (typeof body === 'string') {
    const isJson = /^\s*[{[]/.test(body);
    if (hasCursor && !cursor && isJson) body = body.replaceAll('"{cursor}"', 'null');
    return text(body, isJson ? (v) => JSON.stringify(v).slice(1, -1) : encodeURIComponent);
  }
  const sub = (v) => {
    if (typeof v === 'string') {
      if (v === '{cursor}' && hasCursor) return isEmpty(vars.cursor) ? null : vars.cursor;
      if (v === '{n}' && vars.n != null) return vars.n;
      return text(v, (x) => x);
    }
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  return JSON.stringify(sub(body));
}

// The cursor for the next request, read from a response at pages.cursor_path. The list has ended when it is
// missing, null, empty, or the same cursor we just sent (an API that keeps returning its last page).
// A path with [] ("edges[].cursor") yields one cursor per item; the last one is the page's cursor.
export function nextCursor(data, cursorPath, current) {
  let v = getPath(data, cursorPath);
  if (Array.isArray(v)) v = v.filter((x) => x != null).pop();
  const end = v == null || v === '' || v === false || typeof v === 'object' || String(v) === String(current ?? '');
  return { value: end ? null : v, end };
}

// The next page's address, read from a response at pages.next_url_path ("links.next", "paging.next",
// "next_page_url"). Relative values ("/api/items?page=2", "?page=2") resolve against the URL just fetched.
// null = the list has ended: missing/empty/not a string, or pointing back at the page we are on.
export function nextUrl(data, path, currentUrl) {
  let v = getPath(data, path);
  if (Array.isArray(v)) v = v.filter((x) => x != null).pop();
  if (typeof v !== 'string' || !v.trim()) return null;
  let abs;
  try { abs = new URL(v.trim(), currentUrl).href; } catch { return null; }
  if (!/^https?:$/.test(new URL(abs).protocol)) return null;
  return abs === new URL(currentUrl).href ? null : abs;
}

// intercept.where: keep a captured message only when every path holds the wanted value (or one of a list of
// values), compared as strings so 2 and "2" match. One socket often mixes trades, order books and tickers.
export function messageMatches(data, where) {
  if (!where) return true;
  return Object.entries(where).every(([p, want]) => {
    const got = getPath(data, p);
    return (Array.isArray(want) ? want : [want]).some((w) => String(w) === String(got));
  });
}

// ---------- binary WebSocket messages ----------
// Schema-less Protocol Buffers decoding, the same idea as `protoc --decode_raw`: without the site's .proto file
// there are no field names, so each message becomes an object keyed by field NUMBER ("1", "2", …) and recipe
// paths read like "2.1". A field that occurs more than once becomes an array. Wire types are ambiguous without
// a schema, so: varint → integer (string when beyond 2^53); 64/32-bit → integer when the high bytes are zero
// (timestamps, ids), else double/float; length-delimited → printable UTF-8 text as a string, else a nested
// message if it parses completely, else "base64:…". Throws when the bytes are not a well-formed message.
export function decodeProtobuf(buf, depth = 0) {
  if (depth > 24) throw new Error('protobuf nesting too deep');
  const out = {};
  let i = 0;
  const varint = () => {
    let r = 0n;
    for (let s = 0n; s < 70n; s += 7n) {
      if (i >= buf.length) throw new Error('truncated varint');
      const b = buf[i++];
      r |= BigInt(b & 0x7f) << s;
      if (!(b & 0x80)) return r;
    }
    throw new Error('varint too long');
  };
  const need = (n) => { if (i + n > buf.length) throw new Error('truncated field'); };
  while (i < buf.length) {
    const key = varint();
    const field = Number(key >> 3n);
    const wt = Number(key & 7n);
    if (field < 1 || field > 536870911) throw new Error('bad field number');
    let v;
    if (wt === 0) { const n = varint(); v = n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString(); }
    else if (wt === 1) { need(8); v = buf.readUInt16LE(i + 6) === 0 ? Number(buf.readBigUInt64LE(i)) : buf.readDoubleLE(i); i += 8; }
    else if (wt === 5) { need(4); v = buf[i + 3] === 0 ? buf.readUInt32LE(i) : Math.fround(buf.readFloatLE(i)); i += 4; }
    else if (wt === 2) {
      const len = Number(varint());
      need(len);
      const sub = buf.subarray(i, i + len);
      i += len;
      const text = sub.toString('utf8');
      if (!sub.length || (!/[\u0000-\u001f\u007f\ufffd]/.test(text))) v = text;
      else { try { v = decodeProtobuf(sub, depth + 1); } catch { v = 'base64:' + sub.toString('base64'); } }
    } else throw new Error(`unsupported wire type ${wt}`);
    const k = String(field);
    if (!(k in out)) out[k] = v;
    else if (Array.isArray(out[k])) out[k].push(v);
    else out[k] = [out[k], v];
  }
  return out;
}

// One binary frame → the messages in it (each an object), or [] when nothing could be read.
// gzip/zlib-compressed frames are inflated first; JSON (also Socket.IO-prefixed) wins over protobuf.
// records: { length_bytes, type_bytes } for frames that pack several length-prefixed records (big-endian
// length that counts the type bytes, then the type, then one protobuf message); the type lands in "_type".
export function decodeBinaryFrame(buf, records) {
  let b = Buffer.from(buf);
  try {
    if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
    else if (b[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(b[1])) b = zlib.inflateSync(b);
  } catch { return []; }
  const json = tryParse(b.toString('utf8').replace(/^\d+(?=[[{])/, ''));
  if (json && typeof json === 'object') return [json];
  const parts = [];
  if (records) {
    const lb = records.length_bytes;
    const tb = records.type_bytes || 0;
    for (let i = 0; i + lb <= b.length;) {
      const len = lb === 4 ? b.readUInt32BE(i) : lb === 2 ? b.readUInt16BE(i) : b[i];
      if (len < tb || i + lb + len > b.length) return []; // not this framing after all
      parts.push({ type: tb ? b.readUIntBE(i + lb, tb) : undefined, body: b.subarray(i + lb + tb, i + lb + len) });
      i += lb + len;
    }
  } else parts.push({ body: b });
  const out = [];
  for (const p of parts) {
    try {
      const msg = decodeProtobuf(p.body);
      out.push(p.type === undefined ? msg : { _type: p.type, ...msg });
    } catch { /* not protobuf: skipped and counted by the caller */ }
  }
  return out;
}

// ---------- embedded JSON inside HTML ----------
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
export function scripts(html) {
  const out = [];
  let m;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(html))) out.push({ attrs: m[1], body: m[2] });
  return out;
}

// From index i (which must be "{" or "["), return the index of the matching close bracket, skipping strings.
export function scanBalanced(src, i) {
  let depth = 0;
  let str = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (str) { if (c === '\\') j++; else if (c === str) str = null; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return j; }
  }
  return -1;
}
const scanString = (src, i) => {
  const q = src[i];
  if (q !== '"' && q !== "'") return null;
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === q) return src.slice(i, j + 1);
  }
  return null;
};
// Parse the value that starts at src[i]: a literal {…}/[…], or JSON.parse("…") as Next/Nuxt-style pages emit.
function parseValueAt(src, i) {
  const jp = /^JSON\.parse\(\s*/.exec(src.slice(i, i + 40));
  if (jp) {
    const lit = scanString(src, i + jp[0].length);
    if (!lit) return undefined;
    const inner = lit[0] === '"' ? tryParse(lit) : tryParse('"' + lit.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"') + '"');
    return typeof inner === 'string' ? tryParse(inner) : undefined;
  }
  if (src[i] !== '{' && src[i] !== '[') return undefined;
  const end = scanBalanced(src, i);
  return end < 0 ? undefined : tryParse(src.slice(i, end + 1));
}
export function windowAssignment(html, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:window\\.|window\\[["']|globalThis\\.|var\\s+|let\\s+|const\\s+)${esc}(?:["']\\])?\\s*=\\s*`, 'g');
  for (const s of scripts(html)) {
    if (/\ssrc=/i.test(s.attrs)) continue;
    let m;
    while ((m = re.exec(s.body))) {
      const v = parseValueAt(s.body, m.index + m[0].length);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}
export function windowAssignmentNames(html, limit = 20) {
  const re = /(?:window\.|window\[["']|var\s+|let\s+|const\s+)([A-Za-z_$][\w$]*)(?:["']\])?\s*=\s*(?=JSON\.parse\(|[[{])/g;
  const sizes = new Map();
  for (const s of scripts(html)) {
    if (/\ssrc=/i.test(s.attrs)) continue;
    let m;
    while ((m = re.exec(s.body))) {
      const at = m.index + m[0].length;
      const end = s.body[at] === 'J' ? at + 200 : scanBalanced(s.body, at);
      const size = end < 0 ? 0 : end - at;
      if (size > 40) sizes.set(m[1], Math.max(sizes.get(m[1]) || 0, size)); // skip `var x = {}` noise
    }
  }
  return [...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([n]) => n);
}

// source: "next" | "ldjson" | "window:NAME" | { regex, flags }. Throws a UsageError when nothing is found
// so the model can tell the user which source to try next.
export function extractEmbedded(html, source) {
  if (source === 'next') {
    const b = scripts(html).find((s) => /id=["']?__NEXT_DATA__["']?/i.test(s.attrs));
    if (!b) throw new UsageError('embedded: no <script id="__NEXT_DATA__"> in the page (try source "window:__NUXT__" or strategy dom)');
    const v = tryParse(b.body);
    if (v === undefined) throw new UsageError('embedded: __NEXT_DATA__ is not valid JSON');
    return v;
  }
  if (source === 'ldjson') {
    const all = scripts(html).filter((s) => /type=["']?application\/ld\+json["']?/i.test(s.attrs)).map((s) => tryParse(s.body.trim())).filter((v) => v !== undefined);
    if (!all.length) throw new UsageError('embedded: no application/ld+json blocks in the page');
    return all;
  }
  if (typeof source === 'string' && source.startsWith('window:')) {
    const name = source.slice('window:'.length);
    const v = windowAssignment(html, name);
    if (v === undefined) throw new UsageError(`embedded: no "${name} = {…}" assignment with strict JSON found in inline scripts (candidates: ${windowAssignmentNames(html, 8).join(', ') || 'none'})`);
    return v;
  }
  if (source && typeof source === 'object' && source.regex) {
    const m = html.match(new RegExp(source.regex, source.flags || ''));
    if (!m) throw new UsageError(`embedded: regex ${JSON.stringify(source.regex)} did not match the page`);
    const v = tryParse(m[1] !== undefined ? m[1] : m[0]);
    if (v === undefined) throw new UsageError('embedded: the regex capture is not valid JSON');
    return v;
  }
  throw new UsageError('embedded.source must be "next", "ldjson", "window:NAME" or { "regex": "..." }');
}

// Depth-limited type sketch of a JSON value, same output as helpers.js shape().
export function shape(v, depth = 2) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return depth <= 0 ? `array(${v.length})` : { [`array(${v.length})`]: v.length ? shape(v[0], depth - 1) : 'empty' };
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (depth <= 0) return `object{${keys.slice(0, 8).join(',')}${keys.length > 8 ? ',…' : ''}}`;
    const o = {};
    for (const k of keys.slice(0, 25)) o[k] = shape(v[k], depth - 1);
    if (keys.length > 25) o['…'] = `${keys.length - 25} more keys`;
    return o;
  }
  if (typeof v === 'string') return `string "${shorten(v, 40)}"`;
  return typeof v + ' ' + String(v);
}

// ---------- output ----------
export function csvCell(v) {
  if (v == null) return '';
  let s;
  if (Array.isArray(v)) s = v.map((x) => (x != null && typeof x === 'object' ? JSON.stringify(x) : x == null ? '' : String(x))).join(' | ');
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Append-friendly writers. CSV gets a BOM so Excel detects UTF-8 (Korean, emoji) without an import wizard.
export function writeRows({ file, format, rows, columns, append }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exists = append && fs.existsSync(file) && fs.statSync(file).size > 0;
  if (format === 'csv') {
    const head = exists ? '' : '﻿' + columns.map(csvCell).join(',') + '\n';
    const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')).join('\n') + (rows.length ? '\n' : '');
    (exists ? fs.appendFileSync : fs.writeFileSync)(file, head + body);
  } else if (format === 'jsonl') {
    const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
    (exists ? fs.appendFileSync : fs.writeFileSync)(file, body);
  } else {
    fs.writeFileSync(file, JSON.stringify(rows, null, 2) + '\n'); // json: caller passes the full array
  }
}

export function fillRate(rows, columns) {
  const out = {};
  for (const c of columns) out[c] = rows.length ? Math.round((rows.filter((r) => !isEmpty(r[c])).length / rows.length) * 100) / 100 : 0;
  return out;
}

export function unionColumns(...sources) {
  const cols = [];
  const seen = new Set();
  const add = (k) => { if (!seen.has(k)) { seen.add(k); cols.push(k); } };
  for (const s of sources) {
    if (!s) continue;
    if (Array.isArray(s)) for (const row of s) for (const k of Object.keys(row || {})) add(k);
    else for (const k of Object.keys(s)) add(k);
  }
  return cols;
}
