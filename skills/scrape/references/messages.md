# Phrasings

Render these naturally in the user's language. The shape is always: one line of fact, the options, one recommendation, then wait. Korean and English given; adapt tone to the conversation.

## Confirming the data (step 2)

- ko: "첫 페이지에서 이렇게 읽혔어요. (표) 스크린샷에 박스 친 부분이 수집되는 자리예요. 이게 원하시는 데이터가 맞나요? 빠진 항목이 있으면 말씀해주세요."
- en: "Here is what I read from the first page (table). The boxes in the screenshot are where each value comes from. Is this the data you want? Anything missing?"

When wrong:
- ko: "원하시는 '가격'이 화면에 어떻게 보이나요? 예를 들어 '39,000원'처럼 한 개만 알려주시면 그 자리를 찾을게요."
- en: "How does the 'price' look on the page? Give me one example like '39,000원' and I'll locate it."

## Scope (step 3)

- ko: "한 페이지에 20개씩 약 60페이지, 1,200개쯤이고 5분 정도 걸릴 것 같아요. 전부 모을까요, 최근 200개만 할까요?"
- en: "About 20 per page across ~60 pages, so ~1,200 items and roughly 5 minutes. All of them, or the latest 200?"

Small job, no question:
- ko: "총 3페이지라 바로 수집할게요. 1분 안쪽입니다."
- en: "Only 3 pages, so I'll just collect them. Under a minute."

## Result (step 4)

- ko: "완료했어요. 파일: ~/Downloads/<name>-20261007.csv (1,180행, 59페이지). '할인율'은 할인 없는 상품이라 비어 있는 행이 212개 있어요. 처음 세 줄은 이렇습니다. (표) 다음에 '<name> 다시 수집해줘'라고 하시면 새로 받아올게요."
- en: "Done. File: ~/Downloads/<name>-20261007.csv (1,180 rows, 59 pages). 'discount' is empty in 212 rows — those items have no discount. First three rows: (table). Next time say 'run <name> again' and I'll refresh it."

## Situations

### Official API or data page exists
- ko: "이 사이트는 공식 API가 있어요. 문서 기준으로 월 1,000건까지 무료, 그 이상은 유료입니다 (링크). API를 쓰면 더 정확하고 차단 걱정이 없고, 사이트에서 바로 수집하면 가입 없이 지금 받을 수 있어요. 어느 쪽으로 할까요? 저는 한 번만 받으실 거면 사이트 수집, 계속 쓰실 거면 API를 권해요."
- en: "This site has an official API. According to the docs it's free up to 1,000 calls/month, paid beyond (link). The API is more accurate and never blocked; collecting from the site works right now without signing up. Which do you prefer? For a one-off I'd collect from the site; for something you'll repeat, the API."

No key, no pricing page (RSS, a public JSON feed, an open data portal) — fold it into the confirmation message as one line, no question:
- ko: "참고로 이 사이트는 공식 데이터 제공처가 있어요(링크). 가입이나 키 없이 바로 쓸 수 있고 요금 안내는 없습니다. 반복해서 받으실 거면 그쪽이 안정적이고, 지금은 요청하신 대로 사이트에서 받겠습니다."
- en: "Note: this site also offers an official data source (link) — no sign-up or key, no pricing listed. For repeated collection it's the more stable route; for now I'll collect from the site as you asked."

### Login required
- ko: "이 페이지는 로그인이 필요해요. 열려 있는 Chrome 창에서 로그인해주시면 이어서 진행할게요. 비밀번호는 제가 다루지 않아요."
- en: "This page needs a login. Please sign in in the open Chrome window and tell me when you're done. I don't handle passwords."

### Paywall
- ko: "이 내용은 구독자용이에요. 구독 계정이 있으면 로그인해주시고, 없으면 공개된 부분만 수집할 수 있어요. 어떻게 할까요?"
- en: "This content is for subscribers. If you have an account, sign in; otherwise I can collect only the public part. Which?"

### robots.txt disallows
- ko: "이 사이트는 robots.txt에서 이 경로의 자동 수집을 원하지 않는다고 표시해두었어요. 법적 금지는 아니지만 사이트의 명시적인 요청이에요. 그래도 진행할까요? 기본은 존중하는 쪽입니다."
- en: "This site's robots.txt marks this path as not for automated collection. It isn't a law, but it is the site's explicit request. Proceed anyway? My default is to respect it."

### Terms of service forbid scraping (separate from robots.txt)
- ko: "이 사이트 이용약관은 자동 수집을 금지하고 있어요(링크). robots.txt와 별개의 명시적 금지라서, 그래도 진행할지는 직접 정하셔야 해요. 기본은 존중하는 쪽입니다. 참고로 이 사이트가 다른 회사 데이터를 재가공한 것이라면 원 발행자의 개발자 포털이 공식 경로입니다."
- en: "This site's terms of service forbid automated collection (link). That's an explicit ban separate from robots.txt, so proceeding is your call; my default is to respect it. If the site repackages another company's data, that company's developer portal is the official route."

### Bot check the user can pass
- ko: "사이트가 사람인지 확인을 요구하고 있어요 (Cloudflare). Chrome 창에서 확인 버튼을 눌러주시면 이어서 할게요."
- en: "The site is asking for a human check (Cloudflare). Please click through it in the Chrome window and I'll continue."

### Blocked, could not proceed
- ko: "이 사이트는 지금 자동 수집을 적극적으로 막고 있어요. JSON 경로도 없고, 확인을 통과한 뒤에도 몇 페이지마다 다시 막혔어요. 가능한 대안은 (1) 공식 API, (2) 필요한 페이지만 직접 보시면서 제가 정리해드리는 방법이에요."
- en: "This site is actively refusing automated collection right now. There was no JSON route, and it re-blocked every few pages even after the check. Alternatives: (1) the official API, (2) you browse the pages you need and I structure what you copy."

### Asked to bypass
- ko: "캡차 자동 풀이나 자동화 흔적을 숨기는 방식은 이 도구에 넣지 않았어요. 사이트가 명시적으로 거부한 걸 뚫는 건 법적 부담이 사용자에게 돌아가서요. 대신 사람이 확인을 통과하면 그 세션으로 이어서 수집하는 방식까지는 가능해요."
- en: "Captcha solving and hiding automation aren't part of this tool — getting past an explicit refusal puts the legal risk on you. What I can do is continue with your session after you pass the check yourself."
