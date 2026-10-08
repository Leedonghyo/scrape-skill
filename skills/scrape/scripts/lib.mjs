/*
 * lib.mjs — pieces shared by collect.mjs, probe-http.mjs and doctor.mjs.
 * Keep Node-only here; anything that must also run in the page lives in page/helpers.js.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPTS_DIR = fileURLToPath(new URL('.', import.meta.url));
export const HELPERS_PATH = path.join(SCRIPTS_DIR, 'page', 'helpers.js');
export const SCRAPE_HOME = path.join(os.homedir(), '.scrape');
export const PAGE_TYPES = ['single', 'urls', 'param', 'next_link', 'scroll'];
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
  if (!['dom', 'http', 'embedded'].includes(r.strategy)) fail('"strategy" must be dom, http or embedded');
  const p = r.pages;
  if (!p || !PAGE_TYPES.includes(p.type)) fail(`"pages.type" must be one of ${PAGE_TYPES.join(', ')}`);
  if (p.type === 'urls' && !(Array.isArray(p.urls) && p.urls.length)) fail('"pages.urls" must be a non-empty array');
  if (['single', 'next_link', 'scroll'].includes(p.type) && !p.start) fail(`"pages.start" is required for pages.type ${p.type}`);
  if (p.type === 'next_link' && !p.next_selector) fail('"pages.next_selector" is required for pages.type next_link');
  if (['next_link', 'scroll'].includes(p.type) && r.strategy !== 'dom') fail(`pages.type ${p.type} only works with strategy dom`);
  if (p.type === 'param') {
    const tmpl = r.strategy === 'http' ? r.http?.url_template || p.template : p.template;
    if (!tmpl || !tmpl.includes('{n}')) fail(r.strategy === 'http' ? '"http.url_template" (or "pages.template") must contain {n}' : '"pages.template" must contain {n}');
  }
  if (!r.fields || typeof r.fields !== 'object') fail('"fields" is required');
  if (r.strategy === 'http' && !(r.http?.url_template || p.template || p.urls || p.start)) fail('"http.url_template" is required for strategy http');
  if (r.strategy === 'embedded' && !r.embedded?.source) fail('"embedded.source" is required for strategy embedded');
  if (r.detail) {
    if (!r.detail.url_field) fail('"detail.url_field" is required');
    if (!r.detail.fields || typeof r.detail.fields !== 'object') fail('"detail.fields" is required');
    if (r.detail.strategy === 'embedded' && !(r.detail.embedded?.source || r.embedded?.source)) fail('"detail.embedded.source" is required when detail.strategy is embedded');
  }
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

// Playwright storageState ({ cookies, origins }) or a bare cookie array.
export function loadStorageState(file) {
  if (!file) return null;
  const p = expandHome(file);
  if (!fs.existsSync(p)) throw new UsageError(`session.cookies_file not found: ${p}`);
  const s = tryParse(fs.readFileSync(p, 'utf8'));
  if (!s) throw new UsageError(`session.cookies_file is not valid JSON: ${p}`);
  return { cookies: Array.isArray(s) ? s : s.cookies || [] };
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

// ---------- JSON paths and fields (grammar identical to page/helpers.js getPath) ----------
export function getPath(obj, p) {
  if (!p || p === '$') return obj;
  const segs = p.replace(/\[(\d+)\]/g, '.$1').replace(/\[\]/g, '.[]').split('.').filter(Boolean);
  let cur = obj;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (cur == null) return undefined;
    if (s === '[]') {
      const rest = segs.slice(i + 1).join('.');
      return Array.isArray(cur) ? cur.map((x) => getPath(x, rest)) : undefined;
    }
    cur = cur[s];
  }
  return cur;
}

// One column from one JSON row. Mirrors value() in helpers.js: regex (group 1 wins), then transform.
export function jsonField(row, raw) {
  const spec = typeof raw === 'string' ? { path: raw } : raw || {};
  let v = getPath(row, spec.path ?? spec.selector ?? '');
  if (v === undefined) v = null;
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
  const iterations = (p?.match(/\[\]/g) || []).length;
  rows = Array.isArray(rows) ? (iterations > 1 ? rows.flat(iterations - 1) : rows) : [rows];
  const names = Object.keys(fields || {});
  return rows
    .filter((r) => r != null)
    .map((r) => (names.length ? Object.fromEntries(names.map((n) => [n, jsonField(r, fields[n])])) : r && typeof r === 'object' && !Array.isArray(r) ? r : { value: r }))
    .filter(hasAnyValue);
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
