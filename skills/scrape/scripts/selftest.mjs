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
  csvCell, cookieHeader, unionColumns, fillRate, parseArgs, validateRecipe, cursorUrl, fillBody, nextCursor, noiseRegex, UsageError,
} from './lib.mjs';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const EXAMPLES = path.join(DIR, '..', 'examples');
const FIXTURE_ORIGIN = 'http://127.0.0.1:8765'; // what examples/local-*.json point at; live tests swap in the real port
const offline = process.argv.includes('--offline');

// ---------- local fixture server ----------
// /shop?page=N renders a list by fetching /api/search?page=N. The API refuses anything whose user-agent
// does not say "Chrome" (a stand-in for fingerprint protection: a bare HTTP client gets 403, the page gets JSON).
// /api/feed is a cursor API (GET ?cursor=, 400 on an empty cursor), /graphql the same feed as a POST with
// variables.after, and /feed a page that loads the feed with a "more" button.
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
  const POSTS = Array.from({ length: 20 }, (_, i) => ({ id: `p${i + 1}`, title: `Post ${i + 1}`, author: { name: `author${(i % 3) + 1}` } }));
  // cursor "c<offset>"; null once the list is exhausted
  const feed = (cursor) => {
    const at = cursor ? Number(String(cursor).slice(1)) : 0;
    return { items: POSTS.slice(at, at + 5), next_cursor: at + 5 < POSTS.length ? `c${at + 5}` : null };
  };
  const feedHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture feed</title></head><body>
<h1>Fixture feed</h1><ul id="list"></ul><button id="more">more</button>
<script>
  let cursor = null;
  const load = () => fetch('/api/feed?limit=5' + (cursor ? '&cursor=' + cursor : '')).then((r) => r.json()).then((d) => {
    for (const it of d.items) { const li = document.createElement('li'); li.textContent = it.title; document.getElementById('list').appendChild(li); }
    cursor = d.next_cursor;
    if (!cursor) document.getElementById('more').remove();
  });
  document.getElementById('more').addEventListener('click', load);
  load();
</script></body></html>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/feed') return send(res, 200, 'text/html; charset=utf-8', feedHtml);
    if (u.pathname === '/api/feed') {
      if (u.searchParams.has('cursor') && !u.searchParams.get('cursor')) return json(res, 400, { error: 'empty cursor' });
      return json(res, 200, feed(u.searchParams.get('cursor')));
    }
    if (u.pathname === '/graphql' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let after;
        try { after = JSON.parse(body).variables.after; } catch { return json(res, 400, { error: 'bad body' }); }
        if (after === '' || after === '{cursor}') return json(res, 400, { error: 'bad cursor' });
        const f = feed(after);
        json(res, 200, { data: { posts: { edges: f.items.map((node) => ({ node })), pageInfo: { endCursor: f.next_cursor, hasNextPage: !!f.next_cursor } } } });
      });
      return undefined;
    }
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

// cursor pagination: URL/body templates and the end-of-list decision
ok('cursorUrl fills and encodes', cursorUrl('https://a.test/f?limit=5&cursor={cursor}', 'a b/=') === 'https://a.test/f?limit=5&cursor=a%20b%2F%3D');
ok('cursorUrl empty drops last param', cursorUrl('https://a.test/f?limit=5&cursor={cursor}', '') === 'https://a.test/f?limit=5');
ok('cursorUrl empty drops first param', cursorUrl('https://a.test/f?cursor={cursor}&limit=5', null) === 'https://a.test/f?limit=5');
ok('cursorUrl empty drops middle/only param', cursorUrl('https://a.test/f?a=1&after={cursor}&b=2', '') === 'https://a.test/f?a=1&b=2' && cursorUrl('https://a.test/f?after={cursor}', '') === 'https://a.test/f');
ok('fillBody graphql first page → null', fillBody({ query: 'q', variables: { first: 20, after: '{cursor}' } }, { cursor: '' }) === '{"query":"q","variables":{"first":20,"after":null}}');
ok('fillBody graphql next page', fillBody({ variables: { after: '{cursor}' } }, { cursor: 'YXJy"' }) === '{"variables":{"after":"YXJy\\""}}');
ok('fillBody {n} keeps a number', fillBody({ page: '{n}', q: 'p{n}' }, { n: 3 }) === '{"page":3,"q":"p3"}');
ok('fillBody string bodies', fillBody('{"after":"{cursor}"}', { cursor: '' }) === '{"after":null}' && fillBody('after={cursor}&n={n}', { cursor: 'a b', n: 2 }) === 'after=a%20b&n=2');
ok('fillBody untouched without vars', fillBody({ a: '{cursor}', b: '{n}' }, {}) === '{"a":"{cursor}","b":"{n}"}');
ok('nextCursor continues', eq(nextCursor({ meta: { next: 'c5' } }, 'meta.next', ''), { value: 'c5', end: false }));
ok('nextCursor ends on null / empty / missing', [{ next: null }, { next: '' }, {}].every((d) => nextCursor(d, 'next', 'c5').end));
ok('nextCursor ends when the cursor did not move', nextCursor({ next: 'c5' }, 'next', 'c5').end === true);
ok('nextCursor [] takes the last item cursor', nextCursor({ edges: [{ cursor: 'a' }, { cursor: 'b' }] }, 'edges[].cursor', 'a').value === 'b');
const curRecipe = (over) => ({ version: 1, name: 'x', strategy: 'http', pages: { type: 'cursor', cursor_path: 'next' }, http: { url_template: 'https://a.test/f?c={cursor}' }, fields: {}, ...over });
ok('validate cursor ok (url, body, intercept)', (() => { try {
  validateRecipe(curRecipe());
  validateRecipe(curRecipe({ http: { url_template: 'https://a.test/graphql', method: 'POST', body: { variables: { after: '{cursor}' } } } }));
  validateRecipe(curRecipe({ strategy: 'intercept', intercept: { url_match: '/f' }, pages: { type: 'cursor', cursor_path: 'next', start: 'https://a.test/' } }));
  return true; } catch { return false; } })());
throws('validate cursor needs cursor_path', () => validateRecipe(curRecipe({ pages: { type: 'cursor' } })));
throws('validate cursor needs a {cursor} slot', () => validateRecipe(curRecipe({ http: { url_template: 'https://a.test/f' } })));
throws('validate cursor not for dom', () => validateRecipe(curRecipe({ strategy: 'dom', pages: { type: 'cursor', cursor_path: 'next', start: 'https://a.test/' } })));

// har-scan.mjs: ranking, base64 / missing bodies, cursor round-trip, and above all no credential in the output
{
  const SECRETS = { bearer: 'FAKE_BEARER_tok_9f8e7d6c5b4a', cookie: 'FAKE_COOKIE_val_a1b2c3d4e5', sig: 'FAKE_SIG_0123456789abcdef', key: 'FAKE_APIKEY_zz99yy88xx77', abck: 'FAKE_ABCK_q1w2e3r4t5y6', cur1: 'FAKE_CURSOR_one_111', cur2: 'FAKE_CURSOR_two_222', resp: 'FAKE_RESPTOKEN_r4nd0m' };
  const hdr = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
  const entry = (method, url, json, { headers = {}, cookies = [], post, encoding, status = 200, mime = 'application/json' } = {}) => ({
    _resourceType: 'fetch',
    request: { method, url, headers: hdr({ 'User-Agent': 'Mozilla/5.0 Chrome/141', Accept: 'application/json', ...headers }), cookies, ...(post ? { postData: { mimeType: 'application/json', text: JSON.stringify(post) } } : {}) },
    response: { status, headers: hdr({ 'Set-Cookie': `sid=${SECRETS.cookie}` }), content: { mimeType: mime, ...(json === undefined ? {} : encoding === 'base64' ? { text: Buffer.from(JSON.stringify(json)).toString('base64'), encoding: 'base64' } : { text: typeof json === 'string' ? json : JSON.stringify(json) }) } },
  });
  const products = (from) => ({ data: { total: 15, items: Array.from({ length: 5 }, (_, i) => ({ id: from + i, title: `기계식 키보드 ${from + i}`, price: 39000 + i, url: `/p/${from + i}` })) }, session: { token: SECRETS.resp } });
  const auth = { headers: { Authorization: `Bearer ${SECRETS.bearer}`, Cookie: `sid=${SECRETS.cookie}; _abck=${SECRETS.abck}`, 'X-Signature': SECRETS.sig, Referer: 'https://shop.test/search' }, cookies: [{ name: 'sid', value: SECRETS.cookie }, { name: '_abck', value: SECRETS.abck }] };
  const posts = (endCursor) => ({ data: { posts: { edges: [{ node: { id: 1, title: 'a' } }, { node: { id: 2, title: 'b' } }, { node: { id: 3, title: 'c' } }], pageInfo: { endCursor, hasNextPage: true } } } });
  const gql = (after) => ({ operationName: 'Posts', query: 'query Posts($after: String) { posts(after: $after) { edges { node { id title } } } }', variables: { after } });
  const har = { log: { version: '1.2', entries: [
    entry('GET', 'https://www.google-analytics.com/g/collect?v=2', { events: Array.from({ length: 60 }, (_, i) => ({ id: i, name: 'page_view', ts: i, a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 })) }),
    entry('GET', 'https://shop.test/', '<html><body>shop</body></html>', { mime: 'text/html' }),
    entry('GET', 'https://shop.test/api/config', { theme: 'dark', flags: { a: true } }),
    entry('GET', `https://shop.test/api/search?q=keyboard&page=1&api_key=${SECRETS.key}`, products(1), { ...auth, encoding: 'base64' }),
    entry('GET', `https://shop.test/api/search?q=keyboard&page=2&api_key=${SECRETS.key}`, products(6), auth),
    entry('GET', 'https://shop.test/api/items/123456/reviews', undefined),
    entry('POST', 'https://shop.test/graphql', posts(SECRETS.cur1), { post: gql(null) }),
    entry('POST', 'https://shop.test/graphql', posts(SECRETS.cur2), { post: gql(SECRETS.cur1) }),
  ] } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-har-'));
  const scan = (obj, args = []) => {
    const file = path.join(tmp, 'sample.har');
    fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
    const r = spawnSync('node', [path.join(DIR, 'har-scan.mjs'), file, ...args], { encoding: 'utf8' });
    let summary = {};
    try { summary = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { /* non-JSON */ }
    return { summary, output: (r.stdout || '') + (r.stderr || ''), code: r.status };
  };
  const res = scan(har, ['--match', '39,000원']);
  const c = res.summary.candidates || [];
  const top = c[0] || {};
  const g = c.find((x) => x.graphql_operation === 'Posts') || {};
  const leaked = Object.entries(SECRETS).filter(([, v]) => res.output.includes(v) || res.output.includes(Buffer.from(v).toString('base64'))).map(([k]) => k);
  ok('noiseRegex comes from helpers.js', noiseRegex().test('www.google-analytics.com') && !noiseRegex().test('shop.test/api/search'));
  ok('har-scan: last stdout line is a JSON summary', res.code === 0 && res.summary.ok === true && res.summary.entries === 8, { code: res.code });
  ok('har-scan: --match ranks the data API first', top.method === 'GET' && /shop\.test\/api\/search/.test(top.url_pattern || '') && top.match === true && res.summary.match?.found === true, top.url_pattern);
  ok('har-scan: array path in [] grammar + item keys', top.items_path === 'data.items[]' && top.rows === 5 && eq(top.item_keys, ['id', 'title', 'price', 'url']), { path: top.items_path, keys: top.item_keys });
  ok('har-scan: URL pattern masks page and secrets', (top.url_pattern || '').includes('page={n}') && (top.url_pattern || '').includes('api_key={secret}') && top.paging?.page_param === 'query:page' && top.calls === 2, top.url_pattern);
  ok('har-scan: header names only, intercept for computed headers', ['authorization', 'cookie', 'x-signature', 'referer'].every((h) => (top.headers || []).includes(h)) && top.recommend?.strategy === 'intercept' && eq(top.antibot_cookies, ['_abck']), top.headers);
  ok('har-scan: graphql cursor round-trip → http + cursor', g.paging?.cursor_param === 'body:variables.after' && g.paging?.cursor_path === 'data.posts.pageInfo.endCursor' && g.paging?.cursor_confirmed === true && g.recommend?.strategy === 'http' && g.recommend?.pages === 'cursor' && g.items_path === 'data.posts.edges[]', g.paging);
  const tracker = c.findIndex((x) => x.noise);
  ok('har-scan: tracker domain flagged and ranked below the real lists despite its bigger array', tracker > c.indexOf(g) && c.indexOf(g) > 0 && c[tracker].rows === 60 && !top.noise, c.map((x) => x.url_pattern));
  ok('har-scan: missing body kept as a low candidate with {id}', c.some((x) => x.body === 'empty' && /\/api\/items\/\{id\}\/reviews$/.test(x.url_pattern) && x.items_path === null));
  ok('har-scan: no credential value on stdout or stderr', leaked.length === 0, leaked);
  // only a base64 body for the endpoint: it must still be decoded and ranked
  const b64 = scan({ log: { entries: [har.log.entries[0], har.log.entries[3]] } });
  ok('har-scan: base64 body decoded', b64.summary.candidates?.[0]?.body === 'base64' && b64.summary.candidates[0].items_path === 'data.items[]' && b64.summary.candidates[0].rows === 5, b64.summary.candidates?.[0]?.body);
  // a sanitized export has no Cookie/Authorization at all → say so
  const clean = scan({ log: { entries: [entry('GET', 'https://shop.test/api/search?page=1', products(1))] } });
  ok('har-scan: sanitized HAR is called out', clean.summary.credentials_absent === true && /sanitized/.test(clean.summary.note || '') && res.summary.credentials_absent === undefined);
  const broken = scan(`{"log":{"entries":[{"request":{"headers":[{"name":"Authorization","value":"Bearer ${SECRETS.bearer}"}]`);
  ok('har-scan: truncated file → exit 1, no echo of its content', broken.code === 1 && broken.summary.ok === false && !broken.output.includes(SECRETS.bearer), { code: broken.code });
  ok('har-scan: not a HAR → exit 1', scan({ hello: 1 }).code === 1);
  fs.rmSync(tmp, { recursive: true, force: true });
}

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
  const run = (recipeFile, args, { keepState = false } = {}) => new Promise((resolve) => {
    const name = JSON.parse(fs.readFileSync(recipeFile, 'utf8')).name;
    const out = path.join(tmp, `${name}.csv`);
    if (!keepState) fs.rmSync(path.join(os.homedir(), '.scrape', 'state', `${name}.json`), { force: true });
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
  const GQL = { version: 1, name: 'local-cursor-graphql', strategy: 'http', pages: { type: 'cursor', cursor_path: 'data.posts.pageInfo.endCursor' }, http: { url_template: `${FIXTURE_ORIGIN}/graphql`, method: 'POST', body: { query: 'query Posts($after: String) { posts(first: 5, after: $after) { edges { node { id title } } pageInfo { endCursor hasNextPage } } }', variables: { after: '{cursor}' } } }, items: { path: 'data.posts.edges[]' }, fields: { id: 'node.id', title: 'node.title' }, rate: { delay_ms: 100, jitter_ms: 50, concurrency: 4 } };
  const FEED = { version: 1, name: 'local-intercept-cursor', strategy: 'intercept', pages: { type: 'cursor', start: `${FIXTURE_ORIGIN}/feed`, cursor_path: 'next_cursor', load_more_selector: '#more', idle_ms: 500 }, intercept: { url_match: '/api/feed', timeout_ms: 5000 }, items: { path: 'items[]' }, fields: { id: 'id', title: 'title' } };
  live.push(
    // http + cursor: 4 pages x 5 rows, first request without the cursor param, null cursor ends the run
    ['local-cursor', local('local-cursor'), [], 20, (s) => s.rows === 20 && s.pages_done === 4 && s.stopped_reason === 'cursor_end'],
    // the same feed as a GraphQL POST: {cursor} inside http.body (null on the first page); concurrency is ignored
    ['local-cursor-graphql', local(GQL), [], 20, (s) => s.rows === 20 && s.stopped_reason === 'cursor_end'],
    // intercept + cursor: the page pages itself through "more"; the cursor only tells us when to stop
    ['local-intercept-cursor', local(FEED), [], 20, (s) => s.rows === 20 && s.intercepted === 4 && s.stopped_reason === 'cursor_end'],
  );
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
  // cursor + --resume: stop after 2 pages, then continue from the cursor saved in ~/.scrape/state
  const part = await run(local('local-cursor'), ['--max-pages', '2']);
  const rest = await run(local('local-cursor'), ['--resume'], { keepState: true });
  const resumed = fs.existsSync(rest.out) ? fs.readFileSync(rest.out, 'utf8').trim().split('\n').length - 1 : 0;
  ok('live cursor --resume: 10 rows, then the other 10 from the saved cursor', part.summary.rows === 10 && part.summary.stopped_reason === 'max_pages' && rest.summary.rows === 10 && rest.summary.rows_previous === 10 && rest.summary.stopped_reason === 'cursor_end' && resumed === 20,
    { first: part.summary.rows, firstStop: part.summary.stopped_reason, second: rest.summary.rows, secondStop: rest.summary.stopped_reason, csvRows: resumed });
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
