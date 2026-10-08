# Strategies and patterns

How to get from "I can see the data in the browser" to a recipe that keeps working. Read the section you need.

## 1. Hidden JSON endpoints (strategy `http`)

Most modern sites render lists from a JSON call. Finding it gives the most stable recipe: no selectors, exact field names, often pagination built in.

1. After the page loads (and after scrolling or paging once), `browser_network_requests(filter: "api|json|graphql|search|list|items|products|feed")` with `static: false`. `overview().api_hints` shows the same from inside the page.
2. Open candidates with `browser_network_request(index)`; look for an array whose objects carry the values you see on screen. `part: "response-body"` for just the body.
3. Note what makes the request work: the URL and its paging parameter (`page`, `offset`, `cursor`), request headers like `accept: application/json`, `x-requested-with`, `referer`, `authorization: Bearer …`, `x-api-key`, and whether cookies were sent.
4. Reproduce it without the browser: `node scripts/probe-http.mjs "<url>" --headers '{"accept":"application/json","referer":"<page>"}'`. Add `--cookies ~/.scrape/sessions/<name>.json` if it needed the session. `status` 200 and `is_json` true → `http` recipe. A challenge page or 403 → the endpoint is fingerprint-protected; use `dom` (or `dom` for the list page plus `detail` fetches).
5. Cursor pagination (`next_cursor`, `after`) is not supported by `pages.type: param`; use `dom` or limit to the first page and say so.

GraphQL: the body is the query. Put the POST body in `http.body` with `{n}` where the page/offset goes; headers must include `content-type: application/json`.

Short-lived tokens (`authorization` that changes per session): the recipe will expire. Note it in `notes` and expect to re-capture the header when re-running.

## 2. Data embedded in the HTML (strategy `embedded`)

Next.js (`<script id="__NEXT_DATA__">`), Nuxt (`window.__NUXT__`), Redux/Vuex (`window.__INITIAL_STATE__`, `__PRELOADED_STATE__`), Apollo (`__APOLLO_STATE__`), Remix (`__remixContext`), and schema.org JSON-LD all ship structured data in the first HTML response.

- `overview().embedded` lists what exists; `embeddedGet("next", "props.pageProps")` shows the shape; drill down until you find the array.
- It only counts as `embedded` if plain HTTP returns that HTML: `probe-http.mjs <page url>` → `embedded.next_data: true` and `blocked.blocked: false`. If the HTML is served only after a challenge, use `dom` and read the same JSON with `embeddedGet` through the browser — or simpler, use DOM selectors.
- JSON-LD (`ldjson`) is great for articles and products: `@type: Product` with `offers.price`, `@type: NewsArticle` with `datePublished`. Fields map with `path`, e.g. `offers.price`.
- Hydration data often contains more than what is rendered (hidden fields, IDs). Mention useful extras to the user as optional columns.

## 3. DOM selectors (strategy `dom`)

- Start from `overview().lists`. The top candidate is usually the data; its `container` is your `items.container` and `fields[].selector` are relative selectors with samples from the first items.
- `findByText("<visible example>")` is the fastest way to map a field the user described. Use the `list.recipe_hint`.
- Confirm with `probe(selector, { within: container })`: `count` ≈ item count, `distinct_texts` high. A field with `count` 1 inside a 20-item list is pointing at the wrong level.
- Attribute values: links `attr: "href"`, images `attr: "src"` (lazy images often use `data-src`), dates `time[datetime]` → `attr: "datetime"`, ratings in class names (`class` + `regex`), prices in `data-price`.
- Stability: `id` and `data-testid` > semantic tag with a readable class (`.price_color`) > tag paths. Hashed classes (`css-1k2j3h`, `sc-AxjAm`) change on every deploy; the helpers skip them, and so should you when hand-editing.
- Text inside a cell that mixes several values ("₩39,000 (10% off)") → use `regex` to pick a part, `transform: "number"` for numbers.

### Tables

A `<table>` is a list: `items.container: "table tbody tr"` (or `table tr:not(:first-child)` when there is no `tbody`), fields `td:nth-child(2)` etc. Header texts tell you column names; use them as field names.

Two-row tables (Hacker News: `tr.athing` holds the title, the next `tr` holds points and comments): make the first row the container and reach the second with the sibling prefix, `"+ .score"`. `probe("+ .score", { within: "tr.athing" })` confirms it.

### Pagination

`pagination()` reports what it sees. Map it:

| what you see | recipe |
|---|---|
| `rel_next` or `next_like` with hrefs | `pages.type: next_link`, `next_selector` from the result |
| `page_params` (`page=2`, `p=3`) or `path_patterns` (`/page/{n}`, `page-{n}.html`) | `pages.type: param`, `template` with `{n}`, `start_n` from the first page you see (sometimes 0) |
| `maybe_infinite_scroll` or a "more / 더보기" button | `pages.type: scroll`, `load_more_selector` if a button exists, `max_rounds` modest; test with `await autoScroll({ rounds: 3, container })` and confirm `item_count` grows |
| nothing, but the API hint has `offset`/`page` | prefer `http` |

Always check what the *last* page looks like: an empty list (collector stops by itself), a repeated last page (set `max_pages` or `output.dedupe_key`), or an error page.

### Detail pages

List page gives title + URL; the user also wants description or specs → `detail` block. Open one detail page in the browser, map its fields the same way (single-row page: no container), test on a second detail page, then set `detail.url_field` and `max_items`. Detail fetches multiply the time: 100 items × 3 s = 5 minutes; say so.

### SPAs and timing

- The list renders after JS: `wait.selector` set to the container selector, or `wait.network_idle: true` when content streams in.
- Content differs per locale: set `session.headers["accept-language"]` for `http`; for `dom` the collector's Chrome uses the system language, note it if it matters.
- Dates like "3일 전" / "2 hours ago" are relative; prefer the `datetime` attribute or a JSON timestamp, else record the collection date in a column.

### iframes and shadow DOM

- `overview().iframes` lists frame URLs. Selectors do not cross frames. If the data is inside one, navigate directly to the frame URL and treat it as the page.
- `overview().shadow_roots > 0` and `probe` finds nothing: the content is in a shadow root. In the browser you can read it with `browser_snapshot` (Playwright pierces shadow DOM), but `extract` does not. Prefer `http`/`embedded`; otherwise tell the user this site needs a custom approach.

### Interaction before the list

Search forms, filters, date pickers: perform them with `browser_click` / `browser_type`. If the resulting URL encodes the state (`?q=…&sort=…`), use it as `pages.start`/`template` and the recipe is reproducible. If it does not, the recipe is `single`/`scroll` from that URL and you note the manual steps in `notes`; re-runs will need the same clicks.

## 4. Verification checklist before the full run

- Sample table shows the right values in the right columns for 5 rows.
- Same selectors work on page 2 (or another detail page).
- `probe` counts match the item count for every field, or the gaps are explained (e.g. "some items have no discount").
- `--dry-run` fill rates ≥ 80% per field, or the user knows why not.
- Estimated time stated; `max_pages` set deliberately.
- `robots.txt` checked; situations (API, login, paywall, block) surfaced and decided by the user.

## 5. Output hygiene

- CSV with UTF-8 BOM (Excel and Korean), one header row, consistent column order = recipe field order.
- Numbers as numbers (`transform: "number"`), URLs absolute, arrays joined by ` | `.
- `output.dedupe_key` (usually the URL field) when pagination may repeat items.
- File name `<name>-<date>.csv` so re-runs do not overwrite history.
