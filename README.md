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

Requirements: [Claude Code](https://claude.com/claude-code) (CLI or desktop app), Node.js 20+, Google Chrome (or Edge). Works in Claude Code and the Claude desktop app; not in claude.ai on the web, and not with other LLM clients.

Paste these three commands, then restart Claude Code:

```bash
claude plugin install playwright
claude plugin marketplace add Leedonghyo/scrape-skill
claude plugin install scrape
```

That is the whole setup. The first command adds the browser Claude drives (a real Chrome window you can see and click in); the next two install this skill. The collector's one Node dependency (`playwright-core`, no browser download) is installed automatically the first time you ask for data — Claude runs `scripts/doctor.mjs --fix` for you.

Then just ask for data from a site: "collect the titles and prices from https://…", "이 사이트에서 상품명이랑 가격 모아줘". The skill triggers on words like collect, scrape, crawl, 모아줘, 수집해줘, 긁어줘.

<details>
<summary>한국어 빠른 설치</summary>

Claude Code(터미널 또는 데스크톱 앱), Node.js 20 이상, Chrome이 있으면 됩니다. 아래 세 줄을 붙여넣고 Claude Code를 재시작하세요.

```bash
claude plugin install playwright
claude plugin marketplace add Leedonghyo/scrape-skill
claude plugin install scrape
```

그다음 "이 사이트에서 ○○ 모아줘"라고 말하면 됩니다. 수집기에 필요한 Node 패키지는 처음 요청할 때 Claude가 알아서 설치합니다. claude.ai 웹이나 다른 LLM에서는 동작하지 않습니다.

</details>

<details>
<summary>Alternative: copy the folder instead of installing the plugin</summary>

```bash
git clone https://github.com/Leedonghyo/scrape-skill
cp -r scrape-skill/skills/scrape ~/.claude/skills/scrape
node ~/.claude/skills/scrape/scripts/doctor.mjs --fix
```

You still need the Playwright browser: `claude plugin install playwright`, or `claude mcp add --scope user playwright -- npx @playwright/mcp@latest`.

</details>

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
