#!/usr/bin/env node
/*
 * selftest.mjs — regression guard for the scrape skill's scripts.
 *
 *   node selftest.mjs            # offline unit tests + live example-recipe runs
 *   node selftest.mjs --offline  # offline unit tests only (no network/browser)
 *
 * Offline tests cover the pure logic that extraction/output depend on (path grammar, field
 * transforms incl. map/regex, JSON rows, embedded-JSON sources, block detection, cookies, CSV).
 * Live tests run the bundled example recipes against the public sandbox sites and assert row
 * counts, so a change that breaks dom/http/embedded/detail/scroll collection is caught. Exit 0
 * only if every test passes.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getPath, jsonField, jsonRows, detectBlockedHttp, extractEmbedded,
  csvCell, cookieHeader, unionColumns, fillRate, parseArgs, UsageError,
} from './lib.mjs';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const offline = process.argv.includes('--offline');
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
  const run = (recipe, args) => {
    const out = path.join(tmp, `${recipe}.csv`);
    fs.rmSync(path.join(os.homedir(), '.scrape', 'state', `${recipe}.json`), { force: true });
    const r = spawnSync('node', [path.join(DIR, 'collect.mjs'), path.join(DIR, '..', 'examples', `${recipe}.json`), '--headless', '--quiet', '--out', out, ...args], { encoding: 'utf8', timeout: 180000 });
    const last = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
    let summary = {};
    try { summary = JSON.parse(last); } catch { /* non-JSON */ }
    return { summary, out, stderr: r.stderr };
  };
  const live = [
    ['books-dom', ['--max-pages', '2'], 40, (s) => s.fill_rate && s.fill_rate.rating === 1],
    ['quotes-http', ['--max-pages', '15'], 100, (s) => s.stopped_reason === 'empty_page'],
    ['quotes-embedded', ['--max-pages', '2'], 20, () => true],
    ['books-detail', ['--max-pages', '1'], 20, (s) => s.fill_rate && s.fill_rate.description > 0],
    ['quotes-scroll', ['--max-pages', '2'], 20, () => true],
  ];
  for (const [recipe, args, minRows, extra] of live) {
    let res;
    try { res = run(recipe, args); } catch (e) { ok(`live ${recipe}`, false, String(e.message)); continue; }
    const s = res.summary;
    ok(`live ${recipe}: ok & >=${minRows} rows & fields match`, !!s.ok && s.rows >= minRows && extra(s), { ok: s.ok, rows: s.rows, stopped: s.stopped_reason });
  }
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
