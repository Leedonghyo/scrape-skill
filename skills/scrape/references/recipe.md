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
| `strategy` | yes | `dom` (real browser, CSS selectors), `http` (fetch a JSON endpoint directly), `embedded` (fetch HTML, parse JSON the page ships) |
| `pages` | yes | how to enumerate pages (below) |
| `items` | no | how to split a page into rows (below). Omit for one row per page |
| `fields` | yes | column definitions (below) |
| `detail` | no | follow a per-row link and extract more columns from the detail page |
| `wait` | no | `dom` only: `{ "selector": css, "timeout_ms": 15000 }` or `{ "network_idle": true }`. A timeout does not abort: the collector logs it, re-checks for a block, and extracts what is there |
| `session` | no | `{ "cookies_file": "~/.scrape/sessions/<name>.json", "headers": {...} }` |
| `rate` | no | `{ "delay_ms": 1500, "jitter_ms": 500, "concurrency": 1 }` (defaults shown). The pause happens before every request, detail pages included. `concurrency` > 1 only for `http` with `param`/`urls` |
| `http` | `http` only | `{ "url_template": "...{n}...", "method": "GET", "headers": {...}, "body": null }`. `url_template` is where `{n}` goes; `pages` then only carries `type: "param"`, `start_n`, `max_pages` |
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
| `next_link` | `start`, `next_selector`, `max_pages` | `dom` only; follows (or clicks, when it is a button) the next element until it disappears |
| `scroll` | `start`, `max_rounds` (default 20), `idle_ms` (default 1500), `load_more_selector` (optional) | `dom` only; scrolls to the bottom (or clicks "load more") until the item count stops growing (`stopped_reason: scroll_idle`). `--max-pages` overrides `max_rounds`; `pages_done` reports rounds |

Every type stops on an empty page (`stop_when_empty`, default true). "Empty" means zero rows after dedupe (`stopped_reason: empty_page` or `all_duplicates`). For `param`, an HTTP 404/410 counts as empty so numbered pagination ends cleanly; other non-2xx statuses are errors. `max_pages` defaults to 20 so a first run never surprises anyone. The CLI flag `--max-pages N` overrides the recipe's `max_pages` for that run.

## `items`

- `dom`: `{ "container": "article.product_pod" }`. Each match is one row; field selectors are evaluated inside it.
- `http` / `embedded`: `{ "path": "data.products[]" }`. Path grammar: `a.b[0].c`, and `[]` means "iterate this array" (`"[]"` alone when the root is the array). Each element is one row. With `fields: {}` the row keeps its own top-level keys.

## `fields`

A string is shorthand: `{ "selector": "..." }` for `dom`, `{ "path": "..." }` for `http`/`embedded` (`selector` is accepted as an alias of `path` there). Field names may be in the user's language (`제목`, `가격`); they become the CSV header verbatim, in recipe order.

| key | strategy | meaning |
|---|---|---|
| `selector` | dom | CSS, relative to the container. `":scope"` means the container itself. A leading `+ ` searches the container's *next sibling* instead (`"+ .score"`), `++ ` the one after — for two-row tables like Hacker News where title and score sit in consecutive `<tr>`s |
| `attr` | dom | `text` (default), `html`, or an attribute name (`href`, `src`, `title`, `datetime`, `data-price`…). `href`/`src` are made absolute unless `absolute: false` |
| `all` | dom | `true` → array of every match instead of the first (arrays are written as `a \| b \| c` in CSV) |
| `join` | dom | with `all`: join the matches into one string, e.g. `"join": "\n\n"` for article paragraphs (`"[data-testid=body] p"`), which also skips ads and widgets that are not `<p>` |
| `path` | http/embedded | path inside the row object |
| `regex` | both | applied to the string value; first capture group wins, else whole match |
| `map` | both | `{ "One": 1, "Two": 2, … }` — replaces the value after `regex`; unknown values pass through. Star ratings in class names, status words, "Y"/"N" flags |
| `transform` | both | `number` (strips everything but digits, `.`, `-`), `trim` |

Order of operations per field: take the value (`attr`/`path`) → `regex` → `map` → `transform`.

Values that are only visible as icons (stars, badges, availability) almost always live in the class name: `{ "selector": "p.star-rating", "attr": "class", "regex": "star-rating (\\w+)", "map": { "One": 1, "Two": 2, "Three": 3, "Four": 4, "Five": 5 } }`.

Include the item's URL as a column whenever there is one, even if the user did not ask: it is the natural `dedupe_key`, it lets the user open the item, and titles are rarely unique.

Prefer selectors in this order: `data-testid`/`id` > semantic tag + meaningful class > tag path. Hashed classes (`css-1x2y3z`, `sc-bdVaJa`) break on the next deploy; the helper already avoids them.

## `detail`

```json
"detail": {
  "url_field": "url",
  "wait": { "selector": "#product_description" },
  "fields": { "description": "#product_description ~ p", "upc": "table tr:nth-child(1) td" },
  "max_items": 200
}
```

The collector visits each row's `url_field` (respecting `rate`) and merges the extra columns; a detail value overrides a list value of the same name unless it is empty. `max_items` caps detail visits per run (dry runs visit at most 3). Detail pages are fetched with the browser even when the list came from `http`, unless `detail.strategy` is `"embedded"` (then `detail.embedded.source`, falling back to the top-level `embedded.source`, and optional `detail.items.path`).

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
Playwright writes the file itself (use an absolute path; the sandbox has no `fs`, but `storageState({ path })` does), so cookie values never pass through the conversation. Reference the file in `session.cookies_file`. `http`/`embedded` strategies send the cookies that match the request host; `dom` imports them into the collector's own Chrome profile. Cookies expire; if a recipe that used to work starts returning login pages, re-export.

## Strategy choice

1. `http` when `browser_network_requests` showed a JSON endpoint and `scripts/probe-http.mjs` reproduces it without a browser (status 200, `is_json`). Fastest, most stable.
2. `embedded` when the HTML itself carries the data (`__NEXT_DATA__`, JSON-LD, `window.__INITIAL_STATE__`, an inline `var data = [...]`) and plain HTTP returns the real page (probe-http shows `blocked: false`).
3. `dom` otherwise. Always works when the user can see the data; slower, and selectors can drift.

Record the reason in `notes`.
