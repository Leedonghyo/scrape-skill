# scrape — 사이트에서 데이터가 필요한 사람을 위한 Claude Code 스킬

*Web scraping skill for Claude Code: describe the data, get a CSV — no selectors, no code. (web scraping · crawler · Playwright · Claude Code plugin · 크롤링 · 데이터 수집)*

URL 하나와 한 문장을 주면 CSV로 받습니다. 셀렉터, 코드, 스크래핑 용어를 몰라도 됩니다.

```
나:      https://books.toscrape.com 여기서 책 제목, 가격, 별점 전부 모아줘
Claude:  (사이트를 열어 샘플 5줄과 박스 친 스크린샷을 보여주며) 이게 맞나요?
나:      응
Claude:  50페이지, 약 3분 걸려요. 전부 할게요. … 완료: ~/Downloads/books-toscrape-20261007.csv (1,000행)
```

## 어떻게 동작하나

Claude가 사람 대신 스크래핑 전문가 역할을 합니다. 순서는 항상 같습니다.

1. **분석** — 실제 Chrome 창에서 페이지를 열고, 데이터를 가져올 가장 싸고 안정적인 길을 찾습니다. 숨은 JSON 엔드포인트, 페이지에 박힌 데이터, 또는 화면에 보이는 그대로(DOM) 중에서 고릅니다.
2. **확인** — 처음 5줄을 표로, 그리고 각 값을 어디서 가져오는지 박스 친 스크린샷을 보여주고 "맞나요?" 한 번만 묻습니다. 틀리면 예시값 하나만 받아 다시 찾습니다.
3. **수집** — 범위를 정하고(규모가 크면 한 번 더 물어봄) 속도를 조절하며 전부 받아 CSV로 저장합니다. 수집 방법은 "레시피"로 저장돼서 다음에 "그거 다시 돌려줘"라고 하면 됩니다.

## 설치

필요한 것: [Claude Code](https://claude.com/claude-code)(터미널 또는 데스크톱 앱), Node.js 20 이상, Google Chrome(또는 Edge).

아래 세 줄을 붙여넣고 Claude Code를 재시작하세요.

```bash
claude plugin install playwright
claude plugin marketplace add Leedonghyo/scrape-skill
claude plugin install scrape
```

끝입니다. 첫 줄은 Claude가 조작하는 브라우저(직접 보고 클릭할 수 있는 실제 Chrome 창)를 추가하고, 나머지 두 줄이 이 스킬을 설치합니다. 수집기에 필요한 Node 패키지(`playwright-core`, 브라우저 다운로드 없음)는 처음 데이터를 요청할 때 Claude가 알아서 설치합니다.

> Claude Code와 Claude 데스크톱 앱에서 동작합니다. claude.ai 웹과 다른 LLM(ChatGPT, Cursor 등)에서는 쓸 수 없습니다.

<details>
<summary>플러그인 대신 폴더를 복사해서 쓰기</summary>

```bash
git clone https://github.com/Leedonghyo/scrape-skill
cp -r scrape-skill/skills/scrape ~/.claude/skills/scrape
node ~/.claude/skills/scrape/scripts/doctor.mjs --fix
```

브라우저는 따로 필요합니다: `claude plugin install playwright` 또는 `claude mcp add --scope user playwright -- npx @playwright/mcp@latest`.

</details>

## 사용법

그냥 말하면 됩니다. "모아줘", "수집해줘", "긁어줘", "크롤링", "스크래핑" 같은 말에 스킬이 발동합니다.

- "이 쇼핑몰 카테고리에서 상품명, 가격, 별점 모아줘"
- "이 뉴스 사이트 기사 제목, 작성자, 작성시각, 본문까지 받아줘"
- "채용 공고 목록 전부 엑셀로"
- "지난주에 만든 books-toscrape 레시피 다시 돌려줘"

결과는 `~/Downloads/<이름>-<날짜>.csv`에 저장됩니다. 엑셀에서 바로 열리고 한글이 깨지지 않습니다. 레시피는 `~/.scrape/recipes/`에 남습니다.

## 사이트가 막을 때

막히면 무슨 일인지 사실대로 알려주고, **결정은 사용자가** 합니다. 몰래 우회하거나 몰래 포기하지 않습니다.

| 상황 | Claude가 하는 일 |
|---|---|
| 공식 API나 RSS가 있음 | 무료인지 유료인지, 한도가 얼마인지 링크와 함께 알려주고 API를 쓸지 사이트에서 받을지 물어봄 |
| 로그인이나 유료 구독이 필요함 | Chrome 창에서 직접 로그인하시라고 안내. 비밀번호는 절대 다루지 않음 |
| robots.txt가 금지한 경로 | 멈추고 물어봄. 기본은 존중 |
| 봇 차단(Cloudflare, Akamai, DataDome 등) | 다른 경로를 찾고 → 사람이 확인 창을 통과하게 하고 → 속도를 늦추고 → 그래도 안 되면 **사용자의 실제 브라우저로 페이지를 넘기며 수집** → 끝내 안 되면 솔직히 말함 |

**하지 않는 것**: 캡차 자동 풀이, 자동화 흔적을 숨기는 스텔스 패치, 차단을 피하려는 프록시 로테이션. 그건 사이트의 명시적인 거부를 속이는 일이고, 그 법적 부담은 사용자에게 돌아가기 때문입니다. 사용자 본인의 브라우저를 사람 속도로 움직이는 것까지만 합니다.

## 구조

```
skills/scrape/
├── SKILL.md                 Claude가 따르는 절차 (분석→확인→수집, 상황별 대응, 대화 규칙)
├── scripts/
│   ├── page/helpers.js      페이지에 주입되는 분석 도구: 값 찾기, 목록 감지, 차단 진단, 하이라이트
│   ├── collect.mjs          레시피 실행기 → CSV/JSON (속도 제한, 이어하기, 중복 제거, 차단 시 중단)
│   ├── write-csv.mjs        실제 브라우저로 모은 데이터를 CSV로
│   ├── probe-http.mjs       이 URL이 브라우저 없이도 되는지 판정
│   ├── doctor.mjs           환경 점검과 설치
│   └── selftest.mjs         회귀 테스트
├── references/
│   ├── recipe.md            레시피 JSON 형식
│   ├── strategies.md        숨은 API, 내장 JSON, 셀렉터, 페이지네이션, 무한 스크롤, 상세 페이지
│   ├── blocks.md            봇 차단의 계층과 벤더, 대응 순서
│   └── messages.md          확인·상황별 문구 (한/영)
├── examples/                전략별로 동작하는 레시피 예제
└── evals/                   평가 프롬프트
```

레시피, 세션, 수집기 전용 Chrome 프로필은 `~/.scrape/`에, 결과는 `~/Downloads/`에 저장됩니다.

## 레시피 직접 실행

Claude 없이 터미널에서도 돌릴 수 있습니다.

```bash
node ~/.claude/skills/scrape/scripts/collect.mjs books-toscrape --dry-run        # 첫 페이지만, 파일 저장 없이 확인
node ~/.claude/skills/scrape/scripts/collect.mjs books-toscrape --max-pages 50   # 전체 수집
node ~/.claude/skills/scrape/scripts/collect.mjs books-toscrape --headful --wait-for-human   # 확인 창이 뜨면 멈추고 기다림
node ~/.claude/skills/scrape/scripts/collect.mjs books-toscrape --cdp 9222       # 내 Chrome(원격 디버깅 포트)에 붙어서 수집
```

한 번에 하나만 돌리세요. 수집기는 Chrome 프로필 하나(`~/.scrape/profile`)를 쓰기 때문에 두 레시피를 동시에 실행하면 프로필 잠금에 걸립니다.

플러그인으로 설치했다면 경로는 `~/.claude/plugins/cache/scrape-skill/scrape/<버전>/skills/scrape/scripts/`입니다.

## 테스트

```bash
cd skills/scrape/scripts
npm test              # 오프라인 단위 테스트 + 예제 레시피 실제 실행 (샌드박스 사이트)
npm run test:offline  # 네트워크·브라우저 없이 단위 테스트만
```

경로 문법, 필드 변환(map·regex), JSON 행, 내장 JSON 4종, 차단 감지, 쿠키, CSV를 단위 테스트하고, 예제 레시피 5종(dom·http·embedded·상세페이지·무한스크롤)을 끝까지 돌려 행 수를 확인합니다. 총 37개.

## 한계와 다음 단계

v0.1입니다. 쇼핑몰 목록, 뉴스·블로그 목록, 채용 공고를 먼저 겨냥했습니다.

- 되는 것: 무한 스크롤, 상세 페이지 추적, JSON 엔드포인트, 내장 데이터, 두 줄짜리 테이블, 실제 브라우저 폴백
- 아직 안 되는 것: 커서 기반 API, shadow DOM, iframe 안의 내용
- 다음 후보: 정기 실행과 변경 추적, 로그인 도우미, 추적 파라미터 제거·상대시각 변환, xlsx 출력, 다른 LLM용 MCP 래퍼

<details>
<summary>English</summary>

A Claude Code skill that turns "collect X from this site" into a CSV, for people who don't know scraping. Claude analyzes the page in a real Chrome window, confirms the mapping with sample rows and a highlighted screenshot, collects with rate limiting, and saves a reusable recipe. When a site pushes back (official API, login, paywall, robots.txt, bot checks) it states the facts and lets you decide; it never solves CAPTCHAs, hides automation, or rotates proxies. Install with the three commands above. Works in Claude Code and the Claude desktop app only.

</details>

## 라이선스

MIT
