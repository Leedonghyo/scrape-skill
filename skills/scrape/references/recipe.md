# Recipe format

A recipe is a JSON file that fully describes how to collect one dataset from one site. `scripts/collect.mjs` executes it; the in-page helper `__scrape.extract()` previews it. Recipes live in `~/.scrape/recipes/<name>.json` so the user can say "run the bookstore recipe again" next week. `examples/` holds a working recipe for every strategy and page type.

Keep recipes boring and explicit. A recipe the model can read back and explain in one sentence is a good recipe.

## Minimal example (DOM strategy, list page with "next" links)

```json
{
  "version": 1,
  "name": "books-toscrape",
  "source": "https://books.toscrape.com/",
  "strategy": "dom",
  "pages": { "type": "next_link", "start": "https://books.toscrape.com/catalogue/page-1.html", "next_selector": "li.next a", "max_pages": 50 },
  "wait": { "selector": "article.product_pod" },
  "items": { "container": "article.product_pod" },
  "fields": {
    "title": { "selector": "h3 a", "attr": "title" },
    "price": { "selector": ".price_color", "transform": "number" },
    "url":   { "selector": "h3 a", "attr": "href" }
  },
  "rate": { "delay_ms": 1200, "jitter_ms": 600 },
  "output": { "format": "csv", "dedupe_key": "url" }
}
```

## Top-level keys

| key | required | meaning |
|---|---|---|
| `version` | yes | always `1` |
| `name` | yes | kebab-case; used for file names (`~/Downloads/<name>-<date>.csv`, state, sessions) |
| `source` | yes | the URL the user gave; for humans |
| `strategy` | yes | `dom` (real browser, CSS selectors), `http` (fetch a JSON endpoint directly), `embedded` (fetch HTML, parse JSON the page ships), `intercept` (real browser, read the JSON responses the page itself fetches) |
| `pages` | yes | how to enumerate pages (below) |
| `items` | no | how to split a page into rows (below). Omit for one row per page |
| `fields` | yes | column definitions (below) |
| `detail` | no | follow a per-row link and extract more columns from the detail page |
| `wait` | no | `dom`/`intercept` only: `{ "selector": css, "timeout_ms": 15000 }` or `{ "network_idle": true }`, plus optional `"scroll": { "count": 50, "max_rounds": 10, "idle_ms": 1000 }` (or `true`) to scroll each page until `count` items (`items.container`) exist or the count stops growing — for numbered/next-link pages whose tail lazy-loads (Amazon best sellers: 30 of 50 until scrolled). A timeout does not abort: the collector logs it, re-checks for a block, and extracts what is there |
| `session` | no | `{ "cookies_file": "~/.scrape/sessions/<name>.json", "headers": {...} }` |
| `rate` | no | `{ "delay_ms": 1500, "jitter_ms": 500, "concurrency": 1 }` (defaults shown). The pause happens before every request, detail pages included. `concurrency` > 1 only for `http` with `param`/`urls`; it is ignored (always 1) for `cursor` and for `intercept` |
| `http` | `http` only | `{ "url_template": "...{n}...", "method": "GET", "headers": {...}, "body": null }`. `url_template` is where `{n}` goes; `pages` then only carries `type: "param"`, `start_n`, `max_pages`. With `pages.type: "cursor"` the placeholder is `{cursor}`. Both placeholders also work inside `body` (object or string) |
| `intercept` | `intercept` only | `{ "url_match": "/api/search", "method": "GET", "timeout_ms": 10000, "settle_ms": 100 }`, or for live data `{ "url_match": "/ws/prices", "channel": "websocket", "listen_ms": 10000 }` (`channel`: `http` default, `websocket`, `sse`). Optional for any channel: `where` (keep only messages whose paths hold given values, e.g. `{ "_type": 2 }` or `{ "event_type": ["trade", "fill"] }`); for binary WebSockets `binary_records` (`{ "length_bytes": 4, "type_bytes": 1 }`). `url_match` is a regex tested against each response URL; `method` (optional) narrows it; only JSON content-types count. `timeout_ms` (default 10000) is how long each page gets to make the call; `settle_ms` (default 100) is the quiet time after the last matching call before the collector moves on — see "Intercept" |
| `embedded` | `embedded` only | `{ "source": "next" \| "ldjson" \| "window:NAME" \| { "regex": "...", "flags": "" } }` — see "Embedded sources" |
| `output` | no | `{ "format": "csv" \| "json" \| "jsonl", "path": "~/Downloads/{name}-{date}.csv", "dedupe_key": "url" }`. A `--out` path with `.json`/`.jsonl`/`.csv` sets the format by extension. `{date}` is the local calendar date (YYYYMMDD), not UTC |
| `notes` | no | free text: why this strategy, what to watch for, decisions the user made (robots.txt etc.) |

When the collector stops on a block or login it writes `blocked_by: { vendor, kind, url }` to `~/.scrape/state/<name>.json` and to the summary line, never into the recipe.

## `pages`

| type | fields | behaviour |
|---|---|---|
| `single` | `start` | one page |
| `urls` | `urls: [...]` | explicit list |
| `param` | `template` with `{n}` (dom/embedded; for `http` use `http.url_template`), `start_n` (default 1), `step` (default 1), `max_pages` | `https://site/list?page={n}` or `https://site/catalogue/page-{n}.html` |
| `next_link` | `start`, `next_selector`, `max_pages` | `dom`/`intercept` only; follows (or clicks, when it is a button) the next element until it disappears |
| `scroll` | `start`, `max_rounds` (default 20), `idle_ms` (default 1500), `load_more_selector` (optional) | `dom`/`intercept` only; scrolls to the bottom (or clicks "load more") until the item count (for `intercept`: the number of captured responses) stops growing (`stopped_reason: scroll_idle`). `--max-pages` overrides `max_rounds`; `pages_done` reports rounds |
| `cursor` | `cursor_path`, `start_cursor` (default empty), `max_pages` | `http`/`intercept` only; see "Cursor pagination" |
| `next_url` | `start`, `next_url_path`, `max_pages` | `http`/`embedded` only; fetches `start`, then whatever URL the response gives at `next_url_path` (`links.next`, `paging.next`, `next_page_url`), relative URLs resolved against the page just fetched. Ends with `stopped_reason: no_next_url` when the value is missing, null, empty or points back to an already fetched page |

Every type stops on an empty page (`stop_when_empty`, default true). "Empty" means zero rows after dedupe (`stopped_reason: empty_page` or `all_duplicates`). For `param`, an HTTP 404/410 counts as empty so numbered pagination ends cleanly; other non-2xx statuses are errors. `max_pages` defaults to 20 so a first run never surprises anyone. The CLI flag `--max-pages N` overrides the recipe's `max_pages` for that run.

### Cursor pagination

For APIs that return "where to continue" instead of accepting a page number (`next_cursor`, `after`, `pageInfo.endCursor`, `continuation`).

```json
"strategy": "http",
"pages": { "type": "cursor", "cursor_path": "meta.next_cursor", "max_pages": 50 },
"http": { "url_template": "https://site/api/feed?limit=20&cursor={cursor}" }
```

- `cursor_path` is where each response carries the next cursor, in the same path grammar as `items.path`. A path with `[]` (`data.posts.edges[].cursor`) takes the last item's value.
- `http`: `{cursor}` goes in `http.url_template` or anywhere inside `http.body`. The first request uses `start_cursor`; when that is empty the whole query parameter is removed from the URL (`?limit=20`), and a body value that is exactly `"{cursor}"` becomes `null`.
- `intercept`: needs `start`; `idle_ms` and `load_more_selector` work as for `scroll`. The browser pages by itself (scrolling, or clicking `load_more_selector`), so nothing is substituted; `cursor_path` is only read from each captured response to notice the end. `intercept.url_match` must match the list call only.
- The run ends with `stopped_reason: cursor_end` when the cursor is missing, null, empty or equal to the one just sent. Reaching `max_pages` first is reported as `max_pages`, as for every other type, so the caller can tell "finished" from "cut off". An empty page with a live cursor still stops as `empty_page` unless `stop_when_empty` is false.
- Requests are strictly sequential. `--resume` continues from the last cursor (`cursor.value` in `~/.scrape/state/<name>.json`) for `http`; an `intercept` run cannot resume mid-list because the page owns the cursor. Cursors often expire within minutes to hours, so a resume that returns an error or the first page again means: start over.

## `items`

- `dom`: `{ "container": "article.product_pod" }`. Each match is one row; field selectors are evaluated inside it.
- `http` / `embedded` / `intercept`: `{ "path": "data.products[]" }`. Path grammar: `a.b[0].c`, and `[]` means "iterate this array" (`"[]"` alone when the root is the array; `"$"` is the row itself, for arrays of plain ids). `[*]` iterates an object's values, for stores keyed by id (`product.products[*]` over `{ "id1": {…}, "id2": {…} }`). A path that reaches a string holding JSON keeps going inside it, so the Next.js/Redux habit of shipping `pageProps.initialState` as a JSON string needs no extra step: `props.pageProps.initialState.product.products[*]`. A key that holds dots or brackets goes in quotes inside brackets: `state.loaderData["routes/kr.search.buy-sell._index"].buySellArticles[]` (Remix route ids, `"a.b"` keys); `\"` and `\\` escape inside the quotes, and single quotes work too. Each element is one row. With `fields: {}` the row keeps its own top-level keys.

## `fields`

A string is shorthand: `{ "selector": "..." }` for `dom`, `{ "path": "..." }` for `http`/`embedded`/`intercept` (`selector` is accepted as an alias of `path` there). Field names may be in the user's language (`제목`, `가격`); they become the CSV header verbatim, in recipe order.

| key | strategy | meaning |
|---|---|---|
| `selector` | dom | CSS, relative to the container. `":scope"` means the container itself. A leading `+ ` searches the container's *next sibling* instead (`"+ .score"`), `++ ` the one after — for two-row tables like Hacker News where title and score sit in consecutive `<tr>`s |
| `attr` | dom | `text` (default), `html`, or an attribute name (`href`, `src`, `title`, `datetime`, `data-price`…). `href`/`src` are made absolute unless `absolute: false` |
| `all` | dom | `true` → array of every match instead of the first (arrays are written as `a \| b \| c` in CSV) |
| `join` | dom | with `all`: join the matches into one string, e.g. `"join": "\n\n"` for article paragraphs (`"[data-testid=body] p"`), which also skips ads and widgets that are not `<p>` |
| `path` | http/embedded/intercept | path inside the row object |
| `regex` | both | applied to the string value; first capture group wins, else whole match |
| `map` | both | `{ "One": 1, "Two": 2, … }` — replaces the value after `regex`; unknown values pass through. Star ratings in class names, status words, "Y"/"N" flags |
| `transform` | both | `number` (strips everything but digits, `.`, `-`), `trim`, `count`, `date` |
| `tz` | both | with `transform: "date"`: the output zone, default `Asia/Seoul`. `date` turns epoch seconds/milliseconds/microseconds and ISO or RFC text that carries a zone (`Z`, `+09:00`, `GMT`) into `YYYY-MM-DD HH:mm:ss` in that zone. Text with no zone (`2026. 10. 21. 15:10`) is already a wall-clock time and is only tidied, never shifted; text that is not a date comes back unchanged |
| `lookup` | http/embedded/intercept | `{ "in": "<path to another table in the same document>", "where": "<key in that table>", "equals": "<key in this row>" }` — joins a second table: the element of `in` (array or object values) whose `where` equals this row's `equals` (or, if `where` is an array, contains it); `path` is then read from that element. No match = empty |
| `template` | both | `"https://n.news.naver.com/article/{언론사ID}/{기사ID}"` — a column built from the row's other columns (list or detail) after extraction; empty when any placeholder is empty. Takes no `selector`/`path` |
| `absolute` | both | `true` resolves a relative URL (`/kr/buy-sell/…`) against `source` (detail fields: against the detail URL); a string is its own base. `dom` already does this for `href`/`src` |

Order of operations per field: take the value (`attr`/`path`) → `regex` → `map` → `transform`. `count` is the exception: it replaces the value with *how many* there are and ignores `attr`/`regex`/`map` — the number of elements matching `selector` inside the container (`dom`), or the length of the array at `path` (`http`/`embedded`/`intercept`; a missing value counts 0).

Values that are only visible as repeated icons (five `<svg>` stars for a 5-star rating) are counted: `{ "selector": ".rating svg", "transform": "count" }`; if empty stars are drawn too, select only the filled ones (`.rating svg.filled`). Values that are only visible as one icon (stars, badges, availability) almost always live in the class name: `{ "selector": "p.star-rating", "attr": "class", "regex": "star-rating (\\w+)", "map": { "One": 1, "Two": 2, "Three": 3, "Four": 4, "Five": 5 } }`.

Include the item's URL as a column whenever there is one, even if the user did not ask: it is the natural `dedupe_key`, it lets the user open the item, and titles are rarely unique.

Prefer selectors in this order: `data-testid`/`id` > semantic tag + meaningful class > tag path. Hashed classes (`css-1x2y3z`, `sc-bdVaJa`) break on the next deploy; the helper already avoids them.

## Finishing rows

Whatever a person would fix in the CSV after the run belongs in the recipe, so "run it again" gives the same table:

```json
"items": { "path": "data.modules[].items[]", "require": ["순위"] },
"fields": {
  "순위": "image.rank",
  "기사ID": "articleId", "언론사ID": "officeId",
  "기사링크": { "template": "https://n.news.naver.com/article/{언론사ID}/{기사ID}" },
  "링크": { "path": "href", "absolute": true }
}
```

- `items.require`: rows with an empty value in any listed column are dropped before dedupe and `--limit` (banners and ads mixed into a list; 102 rows → the 101 products).
- `template` and `absolute` run on every row in the collector, and `template` also in `extract()`/`collectInto()`, so the preview table shows the built column.
- Order per row: `absolute`, then templates in field order (a template may use an earlier template), then `require`. Detail rows are finished again after the detail columns arrive.

### Joining tables in one document

Store-shaped pages keep related records in separate tables keyed by id. Nike SNKRS (`examples/` has none; this is the live shape):

```json
"embedded": { "source": "next" },
"items": { "path": "props.pageProps.initialState.product.products.data.items[*]" },
"fields": {
  "상품명": "title",
  "출시일시": { "path": "commerceStartDate", "transform": "date" },
  "출시방식": { "lookup": { "in": "props.pageProps.initialState.product.launchViews.data.items", "where": "productId", "equals": "id" }, "path": "method" },
  "슬러그": { "lookup": { "in": "props.pageProps.initialState.product.threads.data.items", "where": "productIds", "equals": "id" }, "path": "seo.slug" },
  "링크": { "template": "https://www.nike.com/kr/launch/t/{슬러그}" }
}
```

## `detail`

```json
"detail": {
  "url_field": "url",
  "wait": { "selector": "#product_description" },
  "fields": { "description": "#product_description ~ p", "upc": "table tr:nth-child(1) td" },
  "max_items": 200
}
```

`detail.strategy` is `dom` (default, the browser), `embedded`, or `http`: one JSON document per item, for official APIs that list ids and serve each item separately. Build the item's API URL with a template and read it with JSON paths (`examples/hn-api.json`):

```json
"pages": { "type": "urls", "urls": ["https://hacker-news.firebaseio.com/v0/topstories.json"] },
"items": { "path": "[]" },
"fields": { "id": "$", "api": { "template": "https://hacker-news.firebaseio.com/v0/item/{id}.json" } },
"detail": { "strategy": "http", "url_field": "api", "fields": { "title": "title", "score": "score" } }
```

The collector visits each row's `url_field` (respecting `rate`) and merges the extra columns; a detail value overrides a list value of the same name unless it is empty. `max_items` caps detail visits per run (dry runs visit at most 3). Detail pages are fetched with the browser even when the list came from `http`, unless `detail.strategy` is `"embedded"` (then `detail.embedded.source`, falling back to the top-level `embedded.source`, and optional `detail.items.path`).

## Intercept

```json
"strategy": "intercept",
"pages": { "type": "param", "template": "https://site/search?page={n}", "max_pages": 20 },
"intercept": { "url_match": "/api/search", "method": "GET" },
"items": { "path": "data.items[]" },
"fields": { "제목": "title", "가격": { "path": "price", "transform": "number" } }
```

`pages` describes the *pages the browser opens* (`single`, `urls`, `param`, `next_link`, `scroll`), exactly as for `dom`; `items` and `fields` describe the *JSON the page receives*, exactly as for `http`. The collector starts listening before each navigation or click, keeps every JSON response whose URL matches `url_match`, and maps each one with `items.path` and `fields`. Details:

- A page that makes the call several times (filters, lazy sections) contributes all of them; a response with the same URL and the same body as an earlier one in the run is ignored. The collector moves on once no matching request is in flight and none has arrived for `settle_ms`; raise it (e.g. 500) when a page fires a second call some time after the first one finished and rows go missing.
- No matching response within `timeout_ms` = zero rows for that page, so the usual `empty_page` stop applies. The summary line carries `intercepted` (responses used); `0` there means `url_match` is wrong or the page did not call the API.
- A matching response with status 403/429 and no usable one beside it is reported as a block (exit code 3), not as an empty page.
- `guard`, `--dry-run`, `--resume`, `--headful`, `--wait-for-human`, `--cdp`, `wait`, `session` and `detail` behave as for `dom`. `rate.concurrency` is always 1.
- Nothing is re-requested or re-signed: the rows are whatever the site sent to the browser.

Live data (`"channel": "websocket"` or `"sse"`): prices, scores and feeds that arrive over a WebSocket or EventSource never show up as an HTTP response. With `channel` set, `url_match` is tested against the socket / event-stream URL, every JSON message the page receives is one input to `items.path`/`fields`, and each page is listened to for `listen_ms` (default 10000) after it loads. Socket.IO frames (`42["tick",{…}]`) are unwrapped to the JSON array, so `items.path: "[1]"` reaches the payload. Messages are not deduplicated (two equal ticks are two events); heartbeats such as `{"type":"ping"}` map to empty rows and are dropped. When a site re-sends the latest event (a reconnect snapshot), set `output.dedupe_key` to the event's id column. The collector only listens; it never sends on the connection. `pages.type: cursor` does not apply to streams.

Binary WebSocket frames (most exchanges) are read without any schema:

1. gzip/zlib-compressed frames are inflated;
2. if the bytes are JSON (or Socket.IO-prefixed JSON) they are used as JSON;
3. otherwise they are decoded as Protocol Buffers the way `protoc --decode_raw` does. There are no field names, so a message becomes `{ "1": …, "2": …, "4": [ … ] }` and fields are paths of field numbers (`"1.1"`, `"5"`). Text that is printable becomes a string, 8/4-byte numbers become integers when they look like timestamps or ids and floating point otherwise, a field seen more than once becomes an array. `items.path: "4[]"` also works when the field occurred only once (one object counts as a one-item list).
4. `binary_records` splits frames that pack several records as `[length][type][protobuf]` (big-endian length counting the type bytes); each record becomes one message with its type in `_type`, so `where: { "_type": 2 }` picks one kind.

Frames that are none of these (MessagePack, CBOR, encrypted or proprietary formats) are skipped and counted in the log. To find the field numbers, run the recipe once with `fields: {}`, `--limit 20 --format json --out <file>` and read the file: each row is a whole decoded message.

## Embedded sources

| `embedded.source` | reads |
|---|---|
| `"next"` | `<script id="__NEXT_DATA__">` |
| `"ldjson"` | every `application/ld+json` block, as an array |
| `"window:NAME"` | the `window.NAME = {...}` / `var NAME = {...}` assignment. The value must be real JSON (or a `JSON.parse("…")` wrapper); the collector never evaluates page code, so a JS object literal with unquoted keys is rejected with the candidate names listed. In that case use `dom` and read the data with `embeddedGet` through the browser |
| `{ "regex": "var data = (\\[[\\s\\S]*?\\]);", "flags": "" }` | capture group 1, parsed as JSON |

## `session`

When the site needs the browser's cookies (login, cleared challenge), export them from the Playwright MCP browser:

```
browser_run_code_unsafe: async (page) => { const s = await page.context().storageState({ path: '<home>/.scrape/sessions/<name>.json' }); return s.cookies.length }
```
Playwright writes the file itself (use an absolute path; the sandbox has no `fs`, but `storageState({ path })` does), so cookie values never pass through the conversation. Reference the file in `session.cookies_file`. `http`/`embedded` strategies send the cookies that match the request host; `dom`/`intercept` import them into the collector's own Chrome profile and also restore the export's localStorage (where single-page apps keep their login token) once per origin, before the page's scripts run. sessionStorage is not part of the export. Cookies expire; if a recipe that used to work starts returning login pages, re-export.

## Strategy choice

1. `http` when `browser_network_requests` showed a JSON endpoint and `scripts/probe-http.mjs` reproduces it without a browser (status 200, `is_json`). Fastest, most stable.
2. `embedded` when the HTML itself carries the data (`__NEXT_DATA__`, JSON-LD, `window.__INITIAL_STATE__`, an inline `var data = [...]`) and plain HTTP returns the real page (probe-http shows `blocked: false`).
3. `intercept` when the JSON call is visible in the browser but probe-http gets a challenge or 403 for it. As slow as `dom`, but no selectors and exact field names.
4. `dom` otherwise. Always works when the user can see the data; slower, and selectors can drift.

Record the reason in `notes`.
