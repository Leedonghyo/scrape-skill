# scrape — a Claude Code skill for people who need data from a website

[한국어](README.md) · English

Give it a URL and one sentence, get a CSV. No selectors, no code, no scraping vocabulary.

```
Me:      Grab every book title, price and star rating from https://books.toscrape.com
Claude:  (opens the site, shows 5 sample rows and a screenshot with each value boxed) Is this right?
Me:      Yes
Claude:  50 pages, about 3 minutes. Collecting all of it. … Done: ~/Downloads/books-toscrape-20261007.csv (1,000 rows)
```

## How it works

Claude plays the scraping expert so you don't have to. The order is always the same:

1. **Analyze**: opens the page in a real Chrome window and finds the cheapest, most stable route to the data: a hidden JSON endpoint (`http`), data already embedded in the page (`embedded`), responses from an API that only answers a real browser (`intercept`), or what's on screen (`dom`). A free official API that gives you everything you asked for is used by default.
2. **Confirm**: shows the first 5 rows as a table plus a screenshot with each value boxed, and asks once: "Is this right?" If not, it asks for one example value as it appears on screen and tries again.
3. **Collect**: settles the scope (asks again only when it's large), collects everything at a polite pace and writes a CSV. The method is saved as a "recipe", so next time you just say "run that again".

## Install

You need [Claude Code](https://claude.com/claude-code) (terminal or desktop app), Node.js 20+, and Google Chrome (or Edge).

Paste these three lines and restart Claude Code:

```bash
claude plugin install playwright
claude plugin marketplace add scrapesmith/scrape-skill
claude plugin install scrape
```

That's it. The first line adds the browser Claude drives (a real Chrome window you can watch and click in); the other two install this skill. The collector's Node package (`playwright-core`, no browser download) is installed automatically the first time you ask for data.

> Works in Claude Code and the Claude desktop app. Not available on claude.ai web or other LLMs (ChatGPT, Cursor, etc.).

<details>
<summary>Copy the folder instead of using the plugin</summary>

```bash
git clone https://github.com/scrapesmith/scrape-skill
cp -r scrape-skill/skills/scrape ~/.claude/skills/scrape
node ~/.claude/skills/scrape/scripts/doctor.mjs --fix
```

You still need a browser: `claude plugin install playwright` or `claude mcp add --scope user playwright -- npx @playwright/mcp@latest`.

</details>

<details>
<summary>Without Playwright MCP (Playwright CLI)</summary>

If the browser tools (MCP) are missing, Claude asks first: add the MCP and restart, or install Microsoft's [Playwright CLI](https://github.com/microsoft/playwright-cli) and keep going without a restart. With the CLI, `npm install -g @playwright/cli@latest` opens the same real Chrome window. Nothing is installed until you choose.

</details>

## Usage

Just ask. Words like "collect", "scrape", "crawl", "grab" or "pull into a spreadsheet" trigger the skill.

- "Get product name, price and rating from this shop category"
- "Pull headline, author, time and body from this news site"
- "All the job postings on this page, as Excel"
- "Run the books-toscrape recipe again"

Results go to `~/Downloads/<name>-<date>.csv` (UTF-8 with BOM, so Excel opens it cleanly). Recipes live in `~/.scrape/recipes/`.

## When a site pushes back

It tells you what's happening and **you decide**. It never works around a site silently, and never gives up silently.

| Situation | What Claude does |
|---|---|
| Official API or RSS exists | Says whether it's free, the limits, and links the docs. Free and complete → uses it; otherwise collects from the site and mentions the option |
| Login or subscription needed | Asks you to log in yourself in the Chrome window. Never handles passwords |
| robots.txt or terms of use forbid scraping | Stops and asks. The default is to respect it |
| Bot protection (Cloudflare, Akamai, DataDome…) | Looks for another way in (including finding the data API in a HAR file you save) → lets a human pass the check → slows down → **collects page by page in your own real browser** → if nothing works, says so plainly |

**What it won't do**: solve CAPTCHAs, stealth-patch automation, rotate proxies to dodge blocks, or reimplement request signing. Those deceive a site's explicit refusal, and the legal risk lands on you. Driving your own browser at human speed is as far as it goes.

## Layout

```
skills/scrape/
├── SKILL.md                 The procedure Claude follows (analyze → confirm → collect, how to handle blocks, conversation rules)
├── scripts/
│   ├── page/helpers.js      In-page analysis: find values, detect lists, diagnose blocks, highlight, request-header origins, source-map hints
│   ├── collect.mjs          Recipe runner → CSV/JSON (rate limit, resume, dedupe, stop on block)
│   ├── har-scan.mjs         Find data-API candidates in a saved HAR file (never prints header or cookie values)
│   ├── write-csv.mjs        Turn rows gathered in a real browser into a CSV
│   ├── probe-http.mjs       Does this URL work without a browser?
│   ├── doctor.mjs           Environment check and setup
│   └── selftest.mjs         Regression tests
├── references/              Recipe format, strategies, bot-protection layers, message templates (KO/EN)
├── examples/                Working recipes for each strategy
└── evals/                   Evaluation prompts
```

## Run a recipe yourself

No Claude needed:

```bash
node ~/.claude/skills/scrape/scripts/collect.mjs books-toscrape --dry-run        # first page only, nothing saved
node ~/.claude/skills/scrape/scripts/collect.mjs books-toscrape --max-pages 50   # full run
node ~/.claude/skills/scrape/scripts/collect.mjs books-toscrape --headful --wait-for-human   # pause when a check appears
```

Run one at a time: the collector uses a single Chrome profile (`~/.scrape/profile`).

## Tests

```bash
cd skills/scrape/scripts
npm test              # offline unit tests + live runs of the example recipes (sandbox sites + local server)
npm run test:offline  # unit tests only
```

172 tests in total: 145 offline unit tests, plus live end-to-end runs of every strategy (dom, http, embedded, detail pages, infinite scroll, intercept over HTTP/WebSocket/SSE, cursor and next-URL pagination, session restore, resume, feeds that drop old posts, captcha walls vs. harmless widgets).

## Limits and what's next

This is v0.6, aimed first at shop listings, news and blog lists, and job boards.

- Works: infinite scroll (including feeds like Reddit that remove old posts as you scroll), detail pages, JSON endpoints, embedded data, two-row tables, real-browser fallback, fingerprint-protected APIs (`intercept`), live WebSocket/SSE data including binary frames (compressed JSON, Protobuf), cursor/GraphQL pagination, finding APIs from HAR files
- Not yet: shadow DOM, content inside iframes, non-Protobuf binary formats (MessagePack, CBOR)
- Next: scheduled runs and change tracking, a login helper, tracking-parameter cleanup and relative-time conversion, xlsx output, an MCP wrapper for other LLMs

## License

MIT
