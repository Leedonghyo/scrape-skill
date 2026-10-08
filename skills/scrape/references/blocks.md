# Bot protection: what it looks at, how to recognise it, what to do

This skill does not bypass protection. It recognises it, explains it to the user in plain words, lets a human pass a check when the site offers one, and otherwise says honestly that the site does not allow automated collection. This file helps you diagnose quickly and pick the right next step.

## The detection layers

Roughly ordered from "one request" to "how a browser and a person behave over time". Lower layers catch plain HTTP clients; upper layers catch automation that looks like a browser but does not act like a person.

| layer | what is examined | what it mostly catches | consequence for this skill |
|---|---|---|---|
| IP reputation / rate limit | ASN (datacenter vs residential), proxy/VPN/Tor lists, requests per second per IP, country | every script running from a server | Work from the user's own machine (we already do). Keep `rate.delay_ms` ≥ 1200 with jitter, `concurrency` 1. Raise the delay before anything else. |
| TLS fingerprint (JA3/JA4) | cipher suites and their order, extensions order, supported curves, ALPN in the ClientHello | `httpx`, `requests`, `aiohttp`, Node `fetch` — any OpenSSL-based client | `probe-http.mjs` returning a challenge page while the browser shows data = this layer (or the next two). Switch to `dom`; the real Chrome has a real fingerprint. |
| HTTP protocol fingerprint | HTTP/2 SETTINGS values, WINDOW_UPDATE, pseudo-header order, header order and casing | HTTP/1.1 clients and h2 clients with non-Chrome frame values | Same remedy: `dom`. |
| Header consistency | `User-Agent` vs `sec-ch-ua`, `sec-fetch-*`, `Accept-Language`, `Referer`; "claims Chrome but lacks Chrome's headers" | UA-spoofing scripts | For `http` recipes copy the *whole* header set from `browser_network_request`, not just the UA. |
| JS challenge (Cloudflare managed challenge, Akamai sensor, DataDome, HUMAN) | `navigator.webdriver`, plugin and language lists, hardwareConcurrency, screen vs window size, timezone vs IP country, canvas/WebGL/AudioContext results (real GPU vs SwiftShader), fonts, automation globals, a small proof-of-work | headless and non-JS clients instantly; most automation frameworks eventually | Headful real Chrome passes most of these on its own. If the challenge spins forever, the user clicking in the window usually completes it. |
| Behaviour analysis | mouse curvature and acceleration, scroll pattern, typing cadence, click positions, time to first action after load, navigation order, request regularity | robots that fire requests immediately and at fixed intervals | Jittered delays; do not hammer. The collector's rate limiter does this. |
| Turnstile / reCAPTCHA v3 | all of the above folded into a score; token issued silently to humans | token-less POSTs | A human in the Chrome window gets a token. Export cookies afterwards. |
| reCAPTCHA v2 / hCaptcha | an image puzzle, shown when the score is low | everyone with a low score | Ask the user to solve it. Never attempt it, never wire a solver. |
| Honeypots | CSS-hidden links and form fields, `robots.txt` disallowed paths that only bots visit | crawlers that follow every link in the HTML | Only follow links the user can see; respect `robots.txt` by default. |
| Session / cookie consistency | `cf_clearance`, `_abck`, `datadome` cookies bound to IP + TLS + UA; deep links without an entry page | copying cookies from a browser into `httpx` | When a recipe needs browser cookies, prefer `dom` (same Chrome) over `http`. If `http` with exported cookies worked yesterday and fails today, the cookie expired or was bound to the browser; re-export or move to `dom`. |

## Recognising the vendor from `diagnose()`

| vendor | page signals | cookies you may see | kinds |
|---|---|---|---|
| Cloudflare | title "Just a moment…", "Attention Required!", `#challenge-form`, `iframe[src*=challenges.cloudflare.com]` (Turnstile), "Error 1020/1015", "Ray ID" | `cf_clearance`, `__cf_bm` | `js_challenge`, `turnstile`, `access_denied`, `rate_limited` (1015) |
| Akamai Bot Manager | "Access Denied" with `Reference #18.xxxx`, often empty body, 403 | `_abck`, `bm_sz`, `ak_bmsc` | `access_denied` |
| DataDome | `captcha-delivery.com` iframe, `geo.captcha-delivery.com`, 403 with JSON `{"url": ...}` | `datadome` | `captcha`, `js_challenge` |
| HUMAN (PerimeterX) | "Press & Hold" button, `#px-captcha`, `px-cloud.net` scripts | `_px2`, `_px3`, `_pxhd` | `captcha`, `js_challenge` |
| Imperva Incapsula | `_Incapsula_Resource`, "Incident ID", "Powered by Incapsula" | `incap_ses_*`, `visid_incap_*` | `js_challenge`, `access_denied` |
| Kasada | 429 with `x-kpsdk-*` headers, blank page that then loads | `KP_UIDz` | `js_challenge` |
| Generic WAF / rate limit | 403/429/503 with short body, "Too many requests", Korean "잠시 후 다시 시도" | — | `access_denied`, `rate_limited` |

`diagnose()` also reports `login_wall` (password field on a thin page) and `paywall_hint` (paywall classes or subscription text). Those are not bot protection; they go to the login / paywall situations in SKILL.md.

## Decision ladder (same as SKILL.md, with detail)

1. **Another door.** Before touching the challenge: did `browser_network_requests` show a JSON endpoint? Does `/sitemap.xml`, `/rss`, `/feed`, an AMP (`/amp/`) or mobile (`m.`) host serve the same content? Does Google's cache or the Wayback Machine have it (for historical, non-live needs)? Say which door you found.
2. **Human passes the check.** Tell the user what the site is asking for and that the Chrome window is theirs to click in. Wait. Re-run `overview()`; `diagnosis.blocked` should be false. Export `storageState` to `~/.scrape/sessions/<name>.json` so the collector inherits the cleared session. Prefer `dom` for the recipe: the cleared cookie is bound to that browser's fingerprint.
3. **Behave like a person.** `rate.delay_ms` 3000–6000, `jitter_ms` ≥ 1000, `concurrency` 1, visit the list from its entry page rather than deep-linking, and run `collect.mjs --headful --wait-for-human` so re-checks pause instead of failing. Many sites re-challenge every N pages; the collector prints a message and waits up to five minutes each time.
4. **Collect through the user's real browser.** Some sites (Coupang/Akamai is the canonical case) serve page 1 to anyone but return a hard **HTTP 403** to the collector's own Playwright browser on every page after that — a bare interstitial with no vendor text. This is automation detection: the launched browser carries `navigator.webdriver` and CDP traces, and even clicking the real "next" link, reloading, exported cookies, and the mobile host all still 403. The only thing that passes is a genuinely human browser.
   - **Test first.** Load a page you know is blocked (e.g. page 2) in the browser the user is actually using — Claude in Chrome (`mcp__claude-in-chrome__*`, their real signed-in Chrome) is best; the Playwright MCP window is second. If it shows the real content (not the interstitial), this path works.
   - **Accumulate across navigations.** Each navigation wipes `window`, so push rows into `localStorage` (same origin) instead of holding them in memory: per page, inject `scripts/page/helpers.js`, then `window.__scrape.collectInto(fields, container, { dedupe_key, reset: <true only on the first page> })`, pacing like a person. `collectStatus()` shows the running total.
   - **Finish.** `window.__scrape.drain()` returns every row and clears the store; save that array to a `.json` file and run `node scripts/write-csv.mjs <that.json> --name <name> --dedupe-key <key>` for the same UTF-8-BOM CSV `collect.mjs` would have written. Use the recipe's own `fields`/`container` throughout, so the mapping you confirmed with the user is exactly what gets collected.
   - **Or attach the collector over CDP.** If the user starts their own Chrome with `--remote-debugging-port=9222` on a profile that is not already open, `collect.mjs --cdp 9222` drives that real session (and never closes it). It clears some protections a fresh launch does not, but strong anti-bot can still fingerprint CDP; if it 403s, use the in-session-browser route above.
   - Leave the user's browser and session as you found them: never sign in/out or change anything beyond navigating, and clear any `localStorage` key you added when done.
5. **Honest stop.** If none of these work: "This site is actively refusing automated collection right now. The options were X and Y; I could not get past Z." Offer the manual alternative (the user browses, you help structure what they copy) or the official API if one exists.

## Out of scope, by design

Do not add or suggest: CAPTCHA solving services, stealth patches that remove `navigator.webdriver` or spoof canvas/WebGL, TLS-impersonation libraries wired into the collector, proxy rotation to escape an IP ban, or following hidden links. If the user asks for these, say that this skill hands over to a human instead, and why: those measures are the site's explicit "no", and the tool is built for people who want their data without a legal argument.
