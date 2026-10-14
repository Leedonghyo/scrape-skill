#!/usr/bin/env node
/*
 * selftest.mjs — regression guard for the scrape skill's scripts.
 *
 *   node selftest.mjs            # offline unit tests + live example-recipe runs
 *   node selftest.mjs --offline  # offline unit tests only (no network/browser)
 *   node selftest.mjs --serve    # only run the local fixture server on http://127.0.0.1:8765 (for examples/local-*.json)
 *
 * Offline tests cover the pure logic that extraction/output depend on (path grammar, field
 * transforms incl. map/regex, JSON rows, embedded-JSON sources, block detection, cookies, CSV).
 * Live tests run the bundled example recipes against the public sandbox sites and assert row
 * counts, so a change that breaks dom/http/embedded/detail/scroll collection is caught. The
 * examples/local-*.json recipes run against a fixture server started here with node:http (the
 * sandbox sites have no fingerprint-protected API). Exit 0 only if every test passes.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getPath, jsonField, jsonRows, detectBlockedHttp, extractEmbedded,
  csvCell, cookieHeader, unionColumns, fillRate, parseArgs, validateRecipe, UsageError,
} from './lib.mjs';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const EXAMPLES = path.join(DIR, '..', 'examples');
const FIXTURE_ORIGIN = 'http://127.0.0.1:8765'; // what examples/local-*.json point at; live tests swap in the real port
const offline = process.argv.includes('--offline');

// ---------- local fixture server ----------
// /shop?page=N renders a list by fetching /api/search?page=N. The API refuses anything whose user-agent
// does not say "Chrome" (a stand-in for fingerprint protection: a bare HTTP client gets 403, the page gets JSON).
function fixtureServer(port = 0) {
  const PRODUCTS = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, title: `상품 ${i + 1}`, price: `${(i + 1) * 1000}원` }));
  const send = (res, status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
  const json = (res, status, obj) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
  const shopHtml = (api) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Fixture shop</title></head><body>
<h1>Fixture shop</h1><ul id="list"></ul>
<script>
  const page = new URLSearchParams(location.search).get('page') || '1';
  fetch('${api}?page=' + page).then((r) => r.json()).then((d) => {
    for (const it of (d.data && d.data.items) || []) { const li = document.createElement('li'); li.className = 'item'; li.textContent = it.title + ' ' + it.price; document.getElementById('list').appendChild(li); }
  }).catch(() => {});
</script></body></html>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/shop') return send(res, 200, 'text/html; charset=utf-8', shopHtml('/api/search'));
    if (u.pathname === '/refused') return send(res, 200, 'text/html; charset=utf-8', shopHtml('/api/refused'));
    if (u.pathname === '/api/search') {
      if (!/Chrome/.test(req.headers['user-agent'] || '')) return json(res, 403, { error: 'browsers only' });
      const n = Number(u.searchParams.get('page') || 1);
      return json(res, 200, { data: { items: PRODUCTS.slice((n - 1) * 5, n * 5) } });
    }
    if (u.pathname === '/api/refused') return json(res, 403, { error: 'no' });
    return send(res, 404, 'text/plain', 'not found');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}
if (process.argv.includes('--serve')) {
  const { origin } = await fixtureServer(Number(new URL(FIXTURE_ORIGIN).port));
  console.error(`[selftest] fixture server on ${origin} — try: node collect.mjs ../examples/local-intercept.json --dry-run  (Ctrl-C to stop)`);
  await new Promise(() => {});
}
let pass = 0, fail = 0;
const fails = [];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function ok(name, cond, got) { if (cond) { pass++; } else { fail++; fails.push(`${name}${got !== undefined ? ` (got ${JSON.stringify(got)})` : ''}`); console.error(`  ✗ ${name}${got !== undefined ? ` → ${JSON.stringify(got)}` : ''}`); } }
function throws(name, fn) { try { fn(); ok(name, false, 'no throw'); } catch { pass++; } }

// ---------- offline unit tests ----------
console.error('[selftest] offline unit tests');

// getPath grammar
ok('getPath nested', getPath({ a: { b: [{ c: 7 }] } }, 'a.b[0].c') === 7);
ok('getPath array iterate', eq(getPath({ q: [{ t: 1 }, { t: 2 }] }, 'q[].t'), [1, 2]));
ok('getPath root array', eq(getPath([{ t: 'x' }], '[].t'), ['x']));
ok('getPath missing', getPath({ a: 1 }, 'a.z.y') === undefined);

// jsonField: regex -> map -> transform order, and passthrough of unknown map keys
ok('field regex+map', jsonField({ r: 'star-rating Three' }, { path: 'r', regex: 'star-rating (\\w+)', map: { Three: 3 } }) === 3);
ok('field map unknown passthrough', jsonField({ r: 'Nope' }, { path: 'r', map: { Three: 3 } }) === 'Nope');
ok('field transform number', jsonField({ p: '₩37,800원' }, { path: 'p', transform: 'number' }) === 37800);
ok('field transform trim', jsonField({ s: '  a   b ' }, { path: 's', transform: 'trim' }) === 'a b');
ok('field string shorthand', jsonField({ a: { name: 'Zoe' } }, 'a.name') === 'Zoe');

// jsonRows: items.path picks the array, fields map per row
ok('jsonRows', eq(
  jsonRows({ quotes: [{ text: 'a', author: { name: 'X' } }, { text: 'b', author: { name: 'Y' } }] }, { path: 'quotes[]' }, { t: 'text', who: 'author.name' }),
  [{ t: 'a', who: 'X' }, { t: 'b', who: 'Y' }]));

// detectBlockedHttp: status + body markers
ok('block 403', detectBlockedHttp(403, {}, '').kind === 'access_denied');
ok('block 429', detectBlockedHttp(429, {}, '').kind === 'rate_limited');
ok('block cloudflare body', detectBlockedHttp(200, {}, '<html><head><title>Just a moment...</title></head><body>checking your browser</body></html>').blocked === true);
ok('block none', detectBlockedHttp(200, {}, '<html><head><title>All products</title></head><body>ok</body></html>').blocked === false);

// extractEmbedded: the four source kinds, and rejection of a JS object literal
ok('embedded next', getPath(extractEmbedded('<script id="__NEXT_DATA__">{"props":{"pageProps":{"x":1}}}</script>', 'next'), 'props.pageProps.x') === 1);
ok('embedded ldjson', Array.isArray(extractEmbedded('<script type="application/ld+json">{"@type":"ItemList"}</script>', 'ldjson')));
ok('embedded window json', eq(extractEmbedded('<script>window.__S = {"a":[1,2]};</script>', 'window:__S'), { a: [1, 2] }));
ok('embedded regex', eq(extractEmbedded('<script>var data = [{"t":"x"}];</script>', { regex: 'var data = (\\[[\\s\\S]*?\\]);' }), [{ t: 'x' }]));
throws('embedded window JS-literal rejected', () => extractEmbedded('<script>window.__S = {a:1};</script>', 'window:__S'));

// validateRecipe: every bundled example stays valid; intercept needs a usable url_match
for (const f of fs.readdirSync(EXAMPLES).filter((x) => x.endsWith('.json'))) {
  let err = null;
  try { validateRecipe(JSON.parse(fs.readFileSync(path.join(EXAMPLES, f), 'utf8'))); } catch (e) { err = e.message; }
  ok(`example ${f} validates`, err === null, err);
}
const icRecipe = (over) => ({ version: 1, name: 'x', strategy: 'intercept', pages: { type: 'single', start: 'https://a.test/' }, intercept: { url_match: '/api/' }, fields: {}, ...over });
ok('validate intercept ok', (() => { try { validateRecipe(icRecipe()); validateRecipe(icRecipe({ pages: { type: 'scroll', start: 'https://a.test/' } })); return true; } catch { return false; } })());
throws('validate intercept needs url_match', () => validateRecipe(icRecipe({ intercept: {} })));
throws('validate intercept bad regex', () => validateRecipe(icRecipe({ intercept: { url_match: '(' } })));
throws('validate next_link still not for http', () => validateRecipe({ version: 1, name: 'x', strategy: 'http', pages: { type: 'next_link', start: 'https://a.test/', next_selector: 'a' }, fields: {} }));

// csvCell quoting + array join
ok('csv plain', csvCell('abc') === 'abc');
ok('csv quote comma', csvCell('a,b') === '"a,b"');
ok('csv quote dquote', csvCell('a"b') === '"a""b"');
ok('csv array join', csvCell(['A', 'B']) === 'A | B');
ok('csv null', csvCell(null) === '');

// cookieHeader domain/secure/expiry filtering
const cookies = [
  { name: 'a', value: '1', domain: '.coupang.com' },
  { name: 'b', value: '2', domain: 'other.com' },
  { name: 'c', value: '3', domain: 'www.coupang.com', secure: true },
  { name: 'd', value: '4', domain: '.coupang.com', expires: 1 },
];
ok('cookieHeader https', cookieHeader(cookies, 'https://www.coupang.com/x') === 'a=1; c=3');
ok('cookieHeader http drops secure', cookieHeader(cookies, 'http://www.coupang.com/x') === 'a=1');

// unionColumns + fillRate
ok('unionColumns', eq(unionColumns([{ a: 1 }, { a: 1, b: 2 }]), ['a', 'b']));
ok('fillRate', eq(fillRate([{ a: 1, b: null }, { a: 2, b: 3 }], ['a', 'b']), { a: 1, b: 0.5 }));

// parseArgs
ok('parseArgs types', eq(parseArgs(['r.json', '--max-pages', '5', '--headful'], { 'max-pages': 'number', headful: 'boolean' }), { _: ['r.json'], 'max-pages': 5, headful: true }));
throws('parseArgs unknown', () => parseArgs(['--nope'], {}));

console.error(`[selftest] offline: ${pass} passed, ${fail} failed`);

// ---------- live example-recipe tests ----------
if (!offline) {
  console.error('[selftest] live example-recipe runs (use --offline to skip)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-selftest-'));
  const fixture = await fixtureServer();
  // Async spawn, not spawnSync: the fixture server lives in this process and must keep answering while the collector runs.
  const run = (recipeFile, args) => new Promise((resolve) => {
    const name = JSON.parse(fs.readFileSync(recipeFile, 'utf8')).name;
    const out = path.join(tmp, `${name}.csv`);
    fs.rmSync(path.join(os.homedir(), '.scrape', 'state', `${name}.json`), { force: true });
    const child = spawn('node', [path.join(DIR, 'collect.mjs'), recipeFile, '--headless', '--quiet', '--out', out, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
    child.on('close', (code) => {
      clearTimeout(timer);
      let summary = {};
      try { summary = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()); } catch { /* non-JSON */ }
      resolve({ summary, out, stderr, code });
    });
  });
  const example = (name) => path.join(EXAMPLES, `${name}.json`);
  // examples/local-*.json point at FIXTURE_ORIGIN; rewrite to the port the fixture really got.
  const local = (recipe) => {
    const text = typeof recipe === 'string' ? fs.readFileSync(example(recipe), 'utf8') : JSON.stringify(recipe);
    const file = path.join(tmp, `${typeof recipe === 'string' ? recipe : recipe.name}.recipe.json`);
    fs.writeFileSync(file, text.replaceAll(FIXTURE_ORIGIN, fixture.origin));
    return file;
  };
  const live = [
    ['books-dom', example('books-dom'), ['--max-pages', '2'], 40, (s) => s.fill_rate && s.fill_rate.rating === 1],
    ['quotes-http', example('quotes-http'), ['--max-pages', '15'], 100, (s) => s.stopped_reason === 'empty_page'],
    ['quotes-embedded', example('quotes-embedded'), ['--max-pages', '2'], 20, () => true],
    ['books-detail', example('books-detail'), ['--max-pages', '1'], 20, (s) => s.fill_rate && s.fill_rate.description > 0],
    ['quotes-scroll', example('quotes-scroll'), ['--max-pages', '2'], 20, () => true],
    // intercept: 3 pages x 5 rows from the JSON the page fetched, numbers parsed, page 4 empty ends the run
    ['local-intercept', local('local-intercept'), [], 15, (s) => s.rows === 15 && s.stopped_reason === 'empty_page' && s.intercepted === 4 && s.sample[0]['가격'] === 1000 && s.fill_rate['제목'] === 1],
  ];
  for (const [recipe, file, args, minRows, extra] of live) {
    const res = await run(file, args);
    const s = res.summary;
    ok(`live ${recipe}: ok & >=${minRows} rows & fields match`, !!s.ok && s.rows >= minRows && extra(s), { ok: s.ok, rows: s.rows, stopped: s.stopped_reason });
  }
  // The fixture API really is closed to a bare HTTP client, so intercept above was not just http in disguise.
  const bare = await fetch(`${fixture.origin}/api/search?page=1`, { headers: { 'user-agent': 'node' } });
  ok('fixture API refuses a non-browser client', bare.status === 403, bare.status);
  // intercept: the API refusing the browser itself is a block (exit 3), not an empty page
  const refused = await run(local({ version: 1, name: 'local-intercept-refused', strategy: 'intercept', pages: { type: 'single', start: `${FIXTURE_ORIGIN}/refused` }, intercept: { url_match: '/api/refused', timeout_ms: 5000 }, items: { path: 'data.items[]' }, fields: { id: 'id' } }), []);
  ok('live intercept: refused API → blocked, exit 3', refused.code === 3 && refused.summary.stopped_reason === 'blocked' && refused.summary.blocked_by?.status === 403, { code: refused.code, stopped: refused.summary.stopped_reason });
  fixture.server.close();
  // write-csv.mjs roundtrip with dedupe
  const rowsFile = path.join(tmp, 'rows.json');
  fs.writeFileSync(rowsFile, JSON.stringify([{ id: '1', n: 10 }, { id: '2', n: 20 }, { id: '2', n: 20 }]));
  const wc = spawnSync('node', [path.join(DIR, 'write-csv.mjs'), rowsFile, '--name', 'selftest', '--dedupe-key', 'id', '--out', path.join(tmp, 'wc.csv')], { encoding: 'utf8' });
  let wsum = {}; try { wsum = JSON.parse((wc.stdout || '').trim().split('\n').pop()); } catch { /* */ }
  const wcsv = fs.existsSync(path.join(tmp, 'wc.csv')) ? fs.readFileSync(path.join(tmp, 'wc.csv')) : Buffer.alloc(0);
  ok('write-csv dedupe to 2 rows', wsum.rows === 2, wsum.rows);
  ok('write-csv has UTF-8 BOM', wcsv.length >= 3 && wcsv[0] === 0xef && wcsv[1] === 0xbb && wcsv[2] === 0xbf);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.error(`\n[selftest] TOTAL: ${pass} passed, ${fail} failed`);
if (fail) { console.error('[selftest] FAILURES:\n  - ' + fails.join('\n  - ')); process.exit(1); }
console.error('[selftest] all green');
