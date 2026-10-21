# Browser through Playwright CLI (when Playwright MCP is not available)

The skill's default browser is the Playwright MCP window. When those tools are missing, Microsoft's Playwright CLI (`@playwright/cli`, Apache-2.0, https://github.com/microsoft/playwright-cli) drives the same kind of real Chrome through shell commands. Every step of SKILL.md stays the same; only the way each browser call is made changes. The helpers (`scripts/page/helpers.js`), the recipes and the collector are identical.

Use it only after the user chose it (messages.md, "No browser tool yet"). It installs a global npm program on their machine.

## Setup

```
npm install -g @playwright/cli@latest      # what the user agreed to; or, without a global install:
npx -y -p @playwright/cli@latest playwright-cli --version
```

`node scripts/doctor.mjs` reports whether `playwright-cli` is on the PATH. Microsoft's own agent skill (`playwright-cli install --skills`) is not needed; this page is the part of it this skill uses.

Conventions for every command below:

- Always pass the session name `-s=scrape`, so the skill's browser never touches another CLI session the user has.
- Open the browser **headed** with the user's Chrome (`--headed --browser=chrome`). The CLI is headless by default, but logins, bot checks and the highlighted-sample step all need a window the user can see and click in.
- Add `--raw` when you need the value of an `eval` or `run-code`: it prints only the result (JSON), without the status block.
- Snapshots and logs go to `.playwright-cli/` in the current directory; screenshots go where `--filename` says. Keep them under the working directory, as with MCP.

## MCP call → CLI command

| step | Playwright MCP | Playwright CLI |
|---|---|---|
| open | `browser_navigate(url)` | first time: `playwright-cli -s=scrape open <url> --headed --browser=chrome`; afterwards `playwright-cli -s=scrape goto <url>` |
| install helpers | `browser_run_code_unsafe` with the SKILL.md snippet | `playwright-cli -s=scrape --raw run-code "async (page) => { const p = '<skill-dir>/scripts/page/helpers.js'; await page.addInitScript({ path: p }); try { await page.addScriptTag({ path: p }); } catch (e) { await page.reload(); } return await page.evaluate(() => typeof window.__scrape); }"` → `"object"` |
| helper call | `browser_evaluate  () => window.__scrape.overview()` | `playwright-cli -s=scrape --raw eval "() => window.__scrape.overview()"` (async helpers: `"async () => await window.__scrape.robots()"`) |
| page structure | `browser_snapshot` | `playwright-cli -s=scrape snapshot` (writes a `.yml` file; read it; element refs like `e15` come from it) |
| network list | `browser_network_requests(filter: "api\|json\|graphql")` | `playwright-cli -s=scrape requests` (add `--static` for scripts/images); filter with `grep -E 'api\|json\|graphql'` |
| one request | `browser_network_request(index)` | `playwright-cli -s=scrape request <index>` |
| click / type | `browser_click`, `browser_type` | `playwright-cli -s=scrape click <ref>`, `fill <ref> "text"`, `press Enter` |
| scroll | `browser_evaluate  () => window.__scrape.autoScroll({rounds: 2})` | `playwright-cli -s=scrape --raw eval "async () => await window.__scrape.autoScroll({ rounds: 2 })"` |
| screenshot | `browser_take_screenshot(filename)` | `playwright-cli -s=scrape screenshot --filename=.playwright-cli/<name>.png` |
| session export | `browser_run_code_unsafe … storageState({ path })` | `playwright-cli -s=scrape state-save <home>/.scrape/sessions/<name>.json` (absolute path; the file is written by the CLI, values never pass through the conversation) |
| close | `browser_close` | `playwright-cli -s=scrape close` |

`eval` takes a function expression. Quote it for the shell with double quotes and use single quotes inside (`findByText('39,000원')`).

The real-browser fallback (`collectInto` / `drain`) works the same way; save the `--raw eval "() => window.__scrape.drain()"` output to a `.json` file with a shell redirect instead of a heredoc, then run `write-csv.mjs`.

## Commands this skill does not use

- `cookie-get`, `cookie-list`, `localstorage-get`/`-list`, `sessionstorage-get`/`-list`: they print stored values (session cookies, tokens) into the conversation. Use `state-save` to a file, and `requestOrigins()` to learn *where* a header comes from without seeing it.
- `route` with `--body`/`--status`: it answers the page's requests with made-up responses. That is how client-side login gates get faked; this skill does not do that.
- `cookie-set`, `localstorage-set`, `state-load` on a site's own credentials: signing in is the user's job, in the open window.
- `kill-all`, `close-all`, `delete-data`: they reach beyond the `scrape` session into the user's other browsers and profiles.

## Differences to keep in mind

- The CLI session stays open until `close` (a headless one stops after an hour idle; a headed one stays). Close it at the end exactly as SKILL.md step 4.6 says for the MCP window.
- `requests` lists what the page fetched since the last navigation; scroll or page once before reading it, as with MCP.
- If the CLI prints `Page URL` / `Snapshot` blocks around a value, you forgot `--raw`.
