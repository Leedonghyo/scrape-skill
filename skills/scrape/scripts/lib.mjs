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
export const FORMATS = ['csv', 'json', 'jsonl', 'xlsx'];
export const TRANSFORMS = ['number', 'trim', 'count', 'date', 'price', 'currency', 'clean_url'];

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
  // A misspelled transform ("prise") would otherwise be ignored silently and leave the raw text in the column.
  for (const [name, f] of [...Object.entries(r.fields), ...Object.entries(r.detail?.fields || {})]) {
    if (f && typeof f === 'object' && f.transform != null && !TRANSFORMS.includes(f.transform)) fail(`field "${name}": "transform" must be one of ${TRANSFORMS.join(', ')}`);
  }
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
  for (const [where, fields] of [['fields', r.fields], ['detail.fields', r.detail?.fields]]) {
    for (const [n, f] of Object.entries(fields || {})) {
      if (!f || typeof f !== 'object') continue;
      if (f.tz != null) { try { new Intl.DateTimeFormat('en', { timeZone: f.tz }); } catch { fail(`"${where}.${n}.tz" is not a time zone (e.g. "Asia/Seoul", "UTC")`); } }
      const L = f.lookup;
      if (L != null && !(L && typeof L.in === 'string' && typeof L.where === 'string' && (L.equals == null || typeof L.equals === 'string'))) fail(`"${where}.${n}.lookup" must be { "in": "<path to the other table>", "where": "<key in that table>", "equals": "<key in this row>" }`);
      if (L != null && !['http', 'embedded', 'intercept'].includes(where === 'fields' ? r.strategy : r.detail?.strategy === 'dom' ? 'dom' : r.detail?.strategy ?? 'dom')) fail(`"${where}.${n}.lookup" only works on JSON (strategy http, embedded or intercept)`);
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
// "[*]" iterates an object's values (or an array): stores keyed by id, { "id1": {…}, "id2": {…} }.
// A path that meets a string holding JSON keeps going inside it: Next.js/Redux pages often ship
// pageProps.initialState as a JSON string, so "props.pageProps.initialState.product" just works.
const ITER = Symbol('[]');
const VALUES = Symbol('[*]');
export function pathSegments(p) {
  const segs = [];
  const re = /\[\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*\]|\[(\d+)\]|\[\*\]|\[\]|([^.[\]]+)/g;
  for (const m of p.matchAll(re)) {
    if (m[1]) segs.push(m[2].replace(/\\(.)/g, '$1'));
    else if (m[3] !== undefined) segs.push(m[3]);
    else if (m[4] !== undefined) segs.push(m[4]);
    else segs.push(m[0] === '[*]' ? VALUES : ITER);
  }
  return segs;
}
export function getPath(obj, p) {
  if (!p || p === '$') return obj;
  return walkPath(obj, pathSegments(p));
}
// One-entry cache: lookups re-read the same big initialState string for every row.
let lastJsonText, lastJsonValue;
function parseJsonString(str) {
  if (str === lastJsonText) return lastJsonValue;
  const t = str.trimStart();
  if (t[0] !== '{' && t[0] !== '[') return undefined;
  try { lastJsonValue = JSON.parse(str); lastJsonText = str; return lastJsonValue; } catch { return undefined; }
}
function walkPath(obj, segs) {
  let cur = obj;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (cur == null) return undefined;
    if (typeof cur === 'string') { cur = parseJsonString(cur); if (cur === undefined) return undefined; }
    if (s === ITER || s === VALUES) {
      const rest = segs.slice(i + 1);
      if (Array.isArray(cur)) return cur.map((x) => walkPath(x, rest));
      if (typeof cur !== 'object') return undefined;
      return s === VALUES ? Object.values(cur).map((x) => walkPath(x, rest)) : [walkPath(cur, rest)];
    }
    cur = cur[s];
  }
  return cur;
}

// transform: "price" — the amount in a price as a number, reading the number format instead of deleting every
// non-digit (which turns "1.234,56 €" into 1.23456). The last of "," / "." is the decimal mark when both appear;
// a lone "," followed by exactly three digits groups thousands ("39,000원"); a lone "." is a decimal point unless
// it repeats ("1.234.567"). Korean 억/만/천 units add up ("3억 5,000만원" → 350000000). "무료"/"free" → 0.
export const toPrice = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^(?:무료|free|gratis|kostenlos|無料|免费)$/i.test(s)) return 0;
  const plain = (t) => {
    let c = t.replace(/[\s  '’]/g, '');
    const comma = c.lastIndexOf(','), dot = c.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) c = comma > dot ? c.replace(/\./g, '').replace(',', '.') : c.replace(/,/g, '');
    else if (comma >= 0) c = (c.match(/,/g).length > 1 || /,\d{3}$/.test(c)) ? c.replace(/,/g, '') : c.replace(',', '.');
    else if (dot >= 0 && c.match(/\./g).length > 1) c = c.replace(/\./g, '');
    const n = parseFloat(c);
    return Number.isNaN(n) ? null : n;
  };
  const neg = /^[-−]|^\(.*\)$/.test(s) ? -1 : 1;
  if (/\d\s*[억만천]/.test(s)) {
    let total = 0;
    const re = /(\d[\d,.]*)\s*([억만천])?/g;
    let m;
    while ((m = re.exec(s))) total += (plain(m[1]) || 0) * ({ 억: 1e8, 만: 1e4, 천: 1e3 }[m[2]] || 1);
    return neg * total;
  }
  const m = s.match(/\d(?:[\d.,'’\s  ]*\d)?/);
  if (!m) return null;
  const n = plain(m[0]);
  return n == null ? null : neg * n;
};
// transform: "currency" — the ISO 4217 code a price is in, from a code ("USD 12"), a prefixed dollar ("C$",
// "HK$"), a symbol or a word ("원", "円"). A bare "$" is USD and a bare "¥" JPY; null when nothing matches.
const CURRENCY_RULES = [
  [/\b(USD|EUR|GBP|KRW|JPY|CNY|HKD|TWD|AUD|CAD|NZD|SGD|CHF|INR|THB|VND|RUB|TRY|PLN|BRL|MXN|SEK|NOK|DKK|IDR|MYR|PHP|ZAR|AED|SAR|UAH)\b/i, null],
  [/\bRMB\b|人民币|元/, 'CNY'], [/US\$/i, 'USD'], [/C\$|CA\$/i, 'CAD'], [/A\$|AU\$/i, 'AUD'], [/HK\$/i, 'HKD'],
  [/NT\$/i, 'TWD'], [/S\$/i, 'SGD'], [/NZ\$/i, 'NZD'], [/R\$/, 'BRL'], [/zł/i, 'PLN'],
  [/£/, 'GBP'], [/€/, 'EUR'], [/₩|원/, 'KRW'], [/円|¥|￥/, 'JPY'], [/₹/, 'INR'], [/₽/, 'RUB'], [/₫/, 'VND'],
  [/฿/, 'THB'], [/₺/, 'TRY'], [/₴/, 'UAH'], [/\$/, 'USD'],
];
export const toCurrency = (v) => {
  if (v == null || v === '') return null;
  const s = String(v);
  for (const [re, code] of CURRENCY_RULES) { const m = s.match(re); if (m) return code || m[1].toUpperCase(); }
  return null;
};
// transform: "clean_url" — drop tracking parameters (utm_*, fbclid, gclid…) and keep everything else, so the same
// page shared from two places dedupes to one link. A relative URL stays relative.
const TRACKING_PARAM = /^(?:utm_[a-z_]+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|yclid|twclid|mc_cid|mc_eid|igshid|igsh|_hsenc|_hsmi|mkt_tok|ref_src)$/i;
export const cleanUrl = (v) => {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let u;
  try { u = new URL(s, 'http://relative.invalid'); } catch (e) { return v; }
  const keep = [...u.searchParams].filter(([k]) => !TRACKING_PARAM.test(k));
  if (keep.length === [...u.searchParams].length) return s;
  u.search = new URLSearchParams(keep).toString();
  const out = u.href;
  return /^[a-z][a-z\d+.-]*:|^\/\//i.test(s) ? out : out.slice('http://relative.invalid'.length);
};
// Relative times ("5시간 전", "3 hours ago", "5h", "어제") for transform "date": a Date measured back from
// `now`, or { daysAgo } when only the day is known. null when the text is not a relative time.
const RELATIVE_UNITS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
const relativeTime = (str, now) => {
  const s = str.trim().toLowerCase();
  if (/^(?:just now|now|방금(?: 전)?|조금 전|刚刚|たった今)$/.test(s)) return new Date(now);
  const day = { 오늘: 0, today: 0, 今日: 0, 今天: 0, 어제: 1, yesterday: 1, 昨日: 1, 昨天: 1, 그저께: 2, 그제: 2, 'day before yesterday': 2, 一昨日: 2, 前天: 2 }[s];
  if (day !== undefined) return { daysAgo: day };
  const unit = (u) => {
    if (/^(?:s|secs?|seconds?|초|秒)$/.test(u)) return 's';
    if (/^(?:m|mins?|minutes?|분|分|分钟)$/.test(u)) return 'm';
    if (/^(?:h|hrs?|hours?|시간|時間|小时)$/.test(u)) return 'h';
    if (/^(?:d|days?|일|日|天)$/.test(u)) return 'd';
    if (/^(?:w|wks?|weeks?|주|週間|周)$/.test(u)) return 'w';
    if (/^(?:mo|mos|months?|개월|달|か月|ヶ月|个月)$/.test(u)) return 'mo';
    if (/^(?:y|yrs?|years?|년|年)$/.test(u)) return 'y';
    return null;
  };
  const m = s.match(/^(\d+|an?|one)\s*([a-z가-힣぀-ヿ一-鿿]+?)\s*(ago|전|前)?$/);
  if (!m) return null;
  const u = unit(m[2]);
  // "5 minutes" with no "ago" is a duration, not a time; only the short feed forms (5m, 3h, 2d) stand alone.
  if (!u || (!m[3] && !/^(?:s|m|h|d|w|mo|y)$/.test(m[2]))) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
  const d = new Date(now);
  if (u === 'mo') d.setMonth(d.getMonth() - n);
  else if (u === 'y') d.setFullYear(d.getFullYear() - n);
  else d.setTime(d.getTime() - n * RELATIVE_UNITS[u]);
  return d;
};

// transform: "date" — epoch numbers (seconds, milliseconds or microseconds) and ISO text with a zone become
// "YYYY-MM-DD HH:mm:ss" in tz (default Asia/Seoul). Relative text ("5시간 전", "3 hours ago", "5h") is measured
// back from `now`, and "어제"/"yesterday" give the date only. Text without a zone is taken as already local and
// only tidied; text that is not a date at all comes back unchanged rather than lost.
export function toLocalTime(v, tz = 'Asia/Seoul', now = Date.now()) {
  if (v == null || v === '') return null;
  const str = String(v).trim();
  const inTz = (d) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  let d;
  if (typeof v === 'number' || /^\d{9,}(\.\d+)?$/.test(str)) {
    let n = Number(v);
    if (n < 1e11) n *= 1000; else if (n > 1e14) n /= 1000;
    d = new Date(n);
  } else {
    const rel = relativeTime(str, now);
    if (rel && rel.daysAgo !== undefined) { const p = inTz(new Date(now - rel.daysAgo * 864e5)); return `${p.year}-${p.month}-${p.day}`; }
    if (rel) d = rel;
    else {
      const local = str.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(:\d{2})?(?:\.\d+)?)?$/);
      if (local) return local[2] ? `${local[1]} ${local[2]}${local[3] || ':00'}` : local[1];
      d = new Date(str);
      if (Number.isNaN(d.getTime())) return v;
      // No zone in the text: it is a wall-clock time already, so keep its fields instead of shifting it.
      if (!/(Z|GMT|UTC|[+-]\d{2}:?\d{2})\s*$/i.test(str)) {
        const z = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
      }
    }
  }
  if (Number.isNaN(d.getTime())) return v;
  const part = inTz(d);
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}:${part.second}`;
}

// lookup: { in, where, equals } joins another table of the same document: take the collection at `in`
// (array, or an object's values), find the element whose `where` equals this row's `equals` (or, when
// `where` is an array, contains it), then read `path` from that element. No match = empty.
function lookupBase(row, L, doc) {
  const key = getPath(row, L.equals ?? '$');
  if (isEmpty(key)) return undefined;
  let coll = getPath(doc, L.in);
  coll = Array.isArray(coll) ? coll : coll && typeof coll === 'object' ? Object.values(coll) : [];
  return coll.find((c) => {
    const v = getPath(c, L.where);
    return Array.isArray(v) ? v.some((x) => String(x) === String(key)) : v != null && String(v) === String(key);
  });
}

// One column from one JSON row. Mirrors value() in helpers.js: regex (group 1 wins), then transform.
// doc is the whole response, for lookup.
export function jsonField(row, raw, doc) {
  const spec = typeof raw === 'string' ? { path: raw } : raw || {};
  if (spec.template != null) return null; // filled from the other columns by finishRows
  let base = row;
  if (spec.lookup) {
    base = lookupBase(row, spec.lookup, doc ?? row);
    if (base === undefined) return spec.transform === 'count' ? 0 : null;
  }
  let v = getPath(base, spec.path ?? spec.selector ?? '');
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
  if (v != null && spec.transform === 'date') v = toLocalTime(v, spec.tz);
  if (v != null && spec.transform === 'price') v = toPrice(v);
  if (v != null && spec.transform === 'currency') v = toCurrency(v);
  if (v != null && spec.transform === 'clean_url') v = cleanUrl(v);
  return v;
}

// data -> rows. items.path picks the array ("quotes[]"); no items = the whole document is one row.
// Empty fields = keep the row's own top-level keys, handy for "just give me the API rows as a table".
export function jsonRows(data, items, fields) {
  const p = items?.path;
  let rows = p ? getPath(data, p) : data;
  if (rows == null) return [];
  const iterations = p ? pathSegments(p).filter((x) => x === ITER || x === VALUES).length : 0;
  rows = Array.isArray(rows) ? (iterations > 1 ? rows.flat(iterations - 1) : rows) : [rows];
  const names = Object.keys(fields || {});
  return rows
    .filter((r) => r != null)
    .map((r) => (names.length ? Object.fromEntries(names.map((n) => [n, jsonField(r, fields[n], data)])) : r && typeof r === 'object' && !Array.isArray(r) ? r : { value: r }))
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

// ---------- xlsx (no dependency) ----------
// A workbook is a zip of a few XML parts. One sheet: bold, frozen header row with filters; numbers and booleans
// are real cells (sortable, summable), everything else is text written like the CSV (arrays joined with " | ").
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function zipFiles(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const body = zlib.deflateRawSync(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(0, 10); head.writeUInt32LE(crc32(data), 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12); central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(head, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += head.length + nameBuf.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const xmlText = (s) => String(s)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '') // not allowed in XML at all
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i) => { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

export function xlsxBuffer(rows, columns, sheetName = 'data') {
  const cellText = (v) => {
    if (Array.isArray(v)) return v.map((x) => (x != null && typeof x === 'object' ? JSON.stringify(x) : x == null ? '' : String(x))).join(' | ');
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  };
  const cell = (v, ref, header) => {
    if (v == null || v === '') return '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
    const t = cellText(v).slice(0, 32767); // Excel's limit per cell
    return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlText(t)}</t></is></c>`;
  };
  const widths = columns.map((c) => Math.min(60, Math.max(8, String(c).length * 2, ...rows.slice(0, 200).map((r) => (r[c] == null ? 0 : cellText(r[c]).length))) + 2));
  const sheetRows = [`<row r="1">${columns.map((c, i) => cell(c, `${colName(i)}1`, true)).join('')}</row>`];
  rows.forEach((r, n) => sheetRows.push(`<row r="${n + 2}">${columns.map((c, i) => cell(r[c], `${colName(i)}${n + 2}`)).join('')}</row>`));
  const last = `${colName(Math.max(columns.length, 1) - 1)}${rows.length + 1}`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${sheetRows.join('')}</sheetData>${columns.length ? `<autoFilter ref="A1:${last}"/>` : ''}</worksheet>`;
  const name = xmlText(String(sheetName).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'data');
  return zipFiles([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets>${columns.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${name.replace(/'/g, "''")}'!$A$1:$${colName(columns.length - 1)}$${rows.length + 1}</definedName></definedNames>` : ''}</workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ['xl/worksheets/sheet1.xml', sheet],
  ]);
}

// Append-friendly writers. CSV gets a BOM so Excel detects UTF-8 (Korean, emoji) without an import wizard.
export function writeRows({ file, format, rows, columns, append, sheet }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exists = append && fs.existsSync(file) && fs.statSync(file).size > 0;
  if (format === 'csv') {
    const head = exists ? '' : '﻿' + columns.map(csvCell).join(',') + '\n';
    const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')).join('\n') + (rows.length ? '\n' : '');
    (exists ? fs.appendFileSync : fs.writeFileSync)(file, head + body);
  } else if (format === 'jsonl') {
    const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
    (exists ? fs.appendFileSync : fs.writeFileSync)(file, body);
  } else if (format === 'xlsx') {
    fs.writeFileSync(file, xlsxBuffer(rows, columns, sheet)); // like json: caller passes the full array
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
