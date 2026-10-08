# scrape — a Claude Code skill for people who need data from websites

Give Claude a URL and one sentence. Get a CSV.

```
you:    https://books.toscrape.com 여기서 책 제목, 가격, 별점 전부 모아줘
claude: (opens the site, shows 5 sample rows and a screenshot with boxes) 이게 맞나요?
you:    응
claude: 50페이지, 약 3분 걸려요. 전부 할게요. … 완료: ~/Downloads/books-toscrape-20261007.csv (1,000행)
```

No selectors, no code, no scraping vocabulary. Claude looks at the page, figures out the cheapest reliable way to get the data (a hidden JSON endpoint, data embedded in the HTML, or the rendered page), confirms with you using samples, then collects everything with rate limiting and saves a recipe so you can say "run it again" next week.

## What it does when a site pushes back

It tells you what is happening and lets you decide:

- **Official API exists** → says whether it is free or paid and asks which you prefer.
- **Login or paywall** → asks you to sign in in the Chrome window; never touches your password.
- **robots.txt says no** → stops and asks; respects it by default.
- **Bot check (Cloudflare, Akamai, DataDome…)** → looks for another route, asks you to pass the check in the Chrome window, slows down, and if the site still refuses, says so honestly.

It does **not** solve CAPTCHAs, hide automation, or rotate proxies. Those are the site's explicit "no", and this tool is for people who want their data without a legal argument.

## Install

Requirements: [Claude Code](https://claude.com/claude-code), Node.js 20+, Google Chrome (or Edge).

1. Add the Playwright MCP server (a real Chrome window Claude can drive). Either the official plugin:
   ```bash
   claude plugin install playwright
   ```
   or as a plain MCP server:
   ```bash
   claude mcp add --scope user playwright -- npx @playwright/mcp@latest
   ```
2. Install the skill. As a plugin from this repo:
   ```bash
   claude plugin marketplace add <owner>/scrape-skill
   claude plugin install scrape
   ```
   or copy the folder into your personal skills directory:
   ```bash
   git clone https://github.com/<owner>/scrape-skill
   cp -r scrape-skill/skills/scrape ~/.claude/skills/scrape
   ```
3. One-time setup of the collector (installs `playwright-core` into the skill folder; no browser download, it uses your Chrome). Ask Claude to run it, or:
   ```bash
   node ~/.claude/skills/scrape/scripts/doctor.mjs --fix
   ```
   (For the plugin install the path is printed by `claude plugin list`.)

Then just ask Claude for data from a site. The skill triggers on phrases like "collect", "scrape", "crawl", "모아줘", "수집해줘", "긁어줘".

## Layout

```
skills/scrape/
├── SKILL.md                 the workflow Claude follows (5 steps, situations, rules)
├── scripts/
│   ├── page/helpers.js      injected into the page: find values, detect lists, diagnose blocks, highlight
│   ├── collect.mjs          runs a recipe across pages → CSV/JSON (rate limited, resumable, stops on blocks)
│   ├── probe-http.mjs       does this URL work without a browser?
│   └── doctor.mjs           environment check / setup
├── references/
│   ├── recipe.md            the recipe JSON format
│   ├── strategies.md        hidden APIs, embedded JSON, selectors, pagination, infinite scroll, detail pages
│   ├── blocks.md            bot-protection layers and vendors, the decision ladder
│   └── messages.md          phrasings (ko/en) for confirmations and situations
├── examples/                working recipes for each strategy
└── evals/                   test prompts
```

Recipes, sessions and the collector's Chrome profile live in `~/.scrape/`. Output goes to `~/Downloads/`.

## Running a recipe by hand

```bash
node ~/.claude/skills/scrape/scripts/collect.mjs books-toscrape --dry-run      # first page, fill rates, no file
node ~/.claude/skills/scrape/scripts/collect.mjs books-toscrape --max-pages 50 # full run
node ~/.claude/skills/scrape/scripts/collect.mjs books-toscrape --headful --wait-for-human  # pause on human checks
```

## Tests

```bash
cd skills/scrape/scripts
npm test            # offline unit tests + live example-recipe runs (books/quotes sandboxes)
npm run test:offline  # just the offline unit tests (no network/browser)
```

`selftest.mjs` checks the pure logic (path grammar, field transforms incl. map/regex, JSON rows, embedded-JSON sources, block detection, cookies, CSV) and then runs every bundled example recipe end to end, asserting row counts — so a change that breaks dom/http/embedded/detail/scroll collection fails the suite.

## Status

v0.1. Target site types for the first release: shop listings, news/blog lists, job boards. Infinite scroll, detail pages, JSON endpoints and embedded data are supported; cursor-based APIs, shadow DOM and cross-iframe content are not yet. For sites that hard-block an automated browser (e.g. Coupang/Akamai), collection runs through the user's own real browser — see the bot-protection ladder in `skills/scrape/references/blocks.md`.

## License

MIT
