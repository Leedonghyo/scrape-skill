/*
 * scrape skill — in-page helpers. Injected into the target page and exposed as window.__scrape.
 * Everything returns plain JSON so the model can read it. Keep this file browser-only (no Node APIs).
 *
 * Install (Playwright MCP):  browser_run_code_unsafe — its sandbox has no `require`, so let Playwright read the file:
 *   async (page) => { const p = '<skill>/scripts/page/helpers.js';
 *                     await page.addInitScript({ path: p });                                        // every later navigation in this tab
 *                     try { await page.addScriptTag({ path: p }); } catch (e) { await page.reload(); } // current page (strict CSP → reload)
 *                     return await page.evaluate(() => typeof window.__scrape); }                   // "object"
 * Fallback: paste this file's content into browser_evaluate as `() => ( <file content> )`.
 *
 * Then: browser_evaluate  () => window.__scrape.overview()
 */
(() => {
  // Re-installing is cheap and idempotent, so no guard: a newer helpers.js always wins over an init script
  // registered earlier in the same tab.
  const S = { version: 1 };

  // ---------- basics ----------
  const norm = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  const digits = (s) => norm(s).replace(/[^\d]/g, '');
  const cut = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'HEAD', 'META', 'LINK']);
  const isVisible = (el) => {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  // Hashed / generated class names are unstable across deploys; avoid them in selectors.
  const hashy = (c) =>
    !c ||
    c.length > 28 ||
    /[0-9a-f]{6,}/i.test(c) ||
    /\d{4,}/.test(c) ||
    // CSS-in-JS prefixes count only when a separator and a hash follow (sc-bdVaJa, css-1k2j3h, styles_card__3x9Qz);
    // a bare "sc"/"css" prefix wrongly flagged ordinary classes like score, scroll, search.
    /^(css|sc|jss|emotion|chakra|mui|svelte|styles?)[-_][A-Za-z0-9_]{4,}$/i.test(c) ||
    /^(ng-|v-|_)/.test(c) ||
    /^[a-zA-Z]{1,3}[-_]?[A-Za-z0-9]{5,}$/.test(c) && /\d/.test(c) && /[A-Z]/.test(c);
  const STATE_CLASS = /^(active|selected|hover|focus|open|show|shown|hidden|visible|js-|is-|has-|was-|current|loaded|lazy|loading)/;
  const goodClasses = (el) => [...el.classList].filter((c) => !hashy(c) && !STATE_CLASS.test(c)).slice(0, 2);
  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : v.replace(/([^\w-])/g, '\\$1'));
  const tag = (el) => el.tagName.toLowerCase();

  // One-level selector part for an element, preferring stable hooks.
  const ident = (el) => {
    if (el.id && !hashy(el.id) && !/^\d/.test(el.id)) return '#' + esc(el.id);
    for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'itemprop', 'name']) {
      const v = el.getAttribute(a);
      if (v && v.length < 40 && !hashy(v)) return `${tag(el)}[${a}="${esc(v)}"]`;
    }
    const cls = goodClasses(el);
    if (cls.length) return tag(el) + cls.map((c) => '.' + esc(c)).join('');
    return tag(el);
  };
  const signature = (el) => tag(el) + '|' + goodClasses(el).join('.');
  const nthOfType = (el) => {
    const p = el.parentElement;
    if (!p) return 1;
    return [...p.children].filter((c) => c.tagName === el.tagName).indexOf(el) + 1;
  };

  // Selector for `el` that matches only `el` inside `root` (default: document).
  const pathWithin = (el, root) => {
    root = root || document;
    if (el === root) return ':scope';
    // An element inside a shadow root is addressed from its own root; queries fall back into shadow roots, so
    // "div.title" relative to an item still finds the title inside the item's web component.
    if (!(root === document ? document.contains(el) : root.contains(el))) root = el.getRootNode();
    const isTop = root === document || root.nodeType === 11;
    const parts = [];
    const scope = root === document ? document : root;
    // Does [p, ...parts] pin exactly one element inside root? Tested as a descendant chain, which is the
    // conservative reading (if it is unique as a descendant it is unique as a child chain too).
    const unique = (p) => {
      try {
        const sel = [p, ...parts].join(' > ');
        return scope.querySelectorAll(isTop ? sel : ':scope ' + sel).length === 1;
      } catch (e) {
        return false;
      }
    };
    let cur = el;
    let top = null; // highest element included in the chain
    while (cur && cur !== root && cur !== document.documentElement && cur.nodeType === 1) {
      top = cur;
      const plain = ident(cur);
      const parent = cur.parentElement;
      if (plain.startsWith('#')) {
        parts.unshift(plain);
        break;
      }
      // A semantic part (tag.class, tag[data-*]) that already pins the element inside root wins over any
      // :nth-of-type — "span.score", not "span:nth-of-type(1)". Position is the last resort.
      if (plain !== tag(cur) && unique(plain)) {
        parts.unshift(plain);
        break;
      }
      let part = plain;
      if (parent) {
        const same = [...parent.children].filter((c) => c !== cur && c.matches(plain));
        if (same.length) part += `:nth-of-type(${nthOfType(cur)})`;
      }
      const done = unique(part);
      parts.unshift(part);
      if (done) break;
      cur = parent;
    }
    let sel = parts.join(' > ');
    // Inside a root: a chain that starts at a direct child keeps ">", one that stopped early at a semantic
    // ancestor is a descendant selector (":scope span.score").
    if (!isTop && !sel.startsWith(':scope')) sel = (top && top.parentElement === root ? ':scope > ' : ':scope ') + sel;
    return sel;
  };
  const cssPath = (el) => pathWithin(el, document);
  const generalize = (sel) => sel.replace(/:nth-of-type\(\d+\)/g, '');
  const lightQsa = (sel, scope) => {
    try {
      return [...(scope || document).querySelectorAll(sel)];
    } catch (e) {
      return [];
    }
  };
  // ---------- Shadow DOM ----------
  // Web components (Polymer, Lit, Reddit's shreddit, many design systems) render inside shadow roots that CSS
  // selectors cannot cross. A query runs in the light DOM first, exactly as before; only when that finds nothing
  // on a page that has shadow roots does it also look inside every open shadow root below the scope. "a >>> b"
  // says it explicitly: b inside the shadow root of each a. Closed shadow roots stay invisible to page scripts.
  const shadowRootsUnder = (scope) => {
    const out = [];
    const visit = (root) => {
      for (const e of root.querySelectorAll('*')) if (e.shadowRoot) { out.push(e.shadowRoot); visit(e.shadowRoot); }
    };
    if (scope.shadowRoot) { out.push(scope.shadowRoot); visit(scope.shadowRoot); }
    visit(scope);
    return out;
  };
  let shadowSeen = { at: 0, any: false };
  const pageHasShadow = () => {
    const now = Date.now();
    if (now - shadowSeen.at > 1000) shadowSeen = { at: now, any: [...document.querySelectorAll('*')].some((e) => e.shadowRoot) };
    return shadowSeen.any;
  };
  // Every element under scope, shadow roots included (list detection, text search, candidate fields).
  const allUnder = (scope) => {
    const els = [...scope.querySelectorAll('*')];
    if (!pageHasShadow()) return els;
    for (const r of shadowRootsUnder(scope)) els.push(...r.querySelectorAll('*'));
    return els;
  };
  // Crossing out of a shadow root: the parent of a top-level shadow child is the element that hosts it.
  const parentOf = (el) => el.parentElement || (el.parentNode && el.parentNode.nodeType === 11 ? el.parentNode.host : null);
  const qsa = (sel, scope) => {
    scope = scope || document;
    if (sel.includes('>>>')) {
      let cur = [scope];
      sel.split('>>>').map((x) => x.trim()).forEach((part, i) => {
        cur = cur.flatMap((n) => { const base = i === 0 ? n : n.shadowRoot; return base && part ? lightQsa(part, base) : []; });
      });
      return cur;
    }
    const found = lightQsa(sel, scope);
    if (found.length || !pageHasShadow()) return found;
    const seen = new Set();
    const out = [];
    for (const root of shadowRootsUnder(scope)) for (const e of lightQsa(sel, root)) if (!seen.has(e)) { seen.add(e); out.push(e); }
    return out;
  };
  // Text as it renders: a host's shadow content (with slotted light children), without <style>/<script>.
  const deepText = (node) => {
    let s = '';
    const walk = (n) => {
      if (n.nodeType === 3) { s += n.nodeValue; return; }
      if (n.nodeType === 1 && SKIP_TAGS.has(n.tagName)) return;
      if (n.nodeType === 1 && n.shadowRoot) { walk(n.shadowRoot); return; }
      if (n.nodeType === 1 && n.tagName === 'SLOT') { const a = n.assignedNodes({ flatten: true }); if (a.length) { a.forEach(walk); return; } }
      for (const c of n.childNodes) walk(c);
    };
    walk(node);
    return s;
  };
  const textOf = (el) => (pageHasShadow() && (el.shadowRoot || el.querySelector('slot') || [...el.querySelectorAll('*')].some((x) => x.shadowRoot)) ? deepText(el) : el.textContent);

  // Find the repeating "item" ancestor of el (a product card, a table row, a list entry).
  // Picks the ancestor with the most same-signature siblings (>=3); ties go to the deeper one.
  const itemAncestor = (el, min = 3) => {
    let best = null;
    let cur = el;
    while (cur && parentOf(cur) && cur !== document.body) {
      const parent = parentOf(cur);
      const sig = signature(cur);
      const count = [...parent.children].filter((c) => signature(c) === sig).length;
      if (count >= min && (!best || count > best.count)) best = { itemEl: cur, listEl: parent, count };
      cur = parent;
    }
    return best;
  };
  // Shortest selector that matches exactly these list items and nothing else on the page: "div.quote" beats
  // "div.row:nth-of-type(2) > div.col-md-8 > div.quote" and survives layout shuffles. Falls back to the full
  // path when a short form would also catch items elsewhere.
  const listSelector = (listEl, items) => {
    const want = new Set(items);
    const exact = (sel) => {
      try {
        const got = qsa(sel);
        return got.length === want.size && got.every((e) => want.has(e));
      } catch (e) {
        return false;
      }
    };
    const item = ident(items[0]);
    const base = cssPath(listEl);
    const fallback = (base === ':scope' ? '' : base + ' > ') + item;
    for (const c of [item, ident(listEl) + ' > ' + item, fallback]) if (exact(c)) return c;
    return fallback;
  };
  const itemSelector = (info) => listSelector(info.listEl, [...info.listEl.children].filter((c) => signature(c) === signature(info.itemEl)));

  // ---------- extraction (shared with scripts/collect.mjs) ----------
  // transform: "price" — the amount in a price as a number, reading the number format instead of deleting every
  // non-digit (which turns "1.234,56 €" into 1.23456). The last of "," / "." is the decimal mark when both appear;
  // a lone "," followed by exactly three digits groups thousands ("39,000원"); a lone "." is a decimal point unless
  // it repeats ("1.234.567"). Korean 억/만/천 units add up ("3억 5,000만원" → 350000000). "무료"/"free" → 0.
  const toPrice = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    const s = String(v).trim();
    if (/^(?:무료|free|gratis|kostenlos|無料|免费)$/i.test(s)) return 0;
    const plain = (t) => {
      let c = t.replace(/[\s  '’]/g, '');
      const comma = c.lastIndexOf(','), dot = c.lastIndexOf('.');
      if (comma >= 0 && dot >= 0) c = comma > dot ? c.replace(/\./g, '').replace(',', '.') : c.replace(/,/g, '');
      else if (comma >= 0) c = (c.match(/,/g).length > 1 || /,\d{3}$/.test(c)) ? c.replace(/,/g, '') : c.replace(',', '.');
      else if (dot >= 0 && c.match(/\./g).length > 1) c = c.replace(/\./g, '');
      const n = parseFloat(c);
      return Number.isNaN(n) ? null : n;
    };
    const neg = /^[-−]|^\(.*\)$/.test(s) ? -1 : 1;
    if (/\d\s*[억만천]/.test(s)) {
      let total = 0;
      const re = /(\d[\d,.]*)\s*([억만천])?/g;
      let m;
      while ((m = re.exec(s))) total += (plain(m[1]) || 0) * ({ 억: 1e8, 만: 1e4, 천: 1e3 }[m[2]] || 1);
      return neg * total;
    }
    const m = s.match(/\d(?:[\d.,'’\s  ]*\d)?/);
    if (!m) return null;
    const n = plain(m[0]);
    return n == null ? null : neg * n;
  };
  // transform: "currency" — the ISO 4217 code a price is in, from a code ("USD 12"), a prefixed dollar ("C$",
  // "HK$"), a symbol or a word ("원", "円"). A bare "$" is USD and a bare "¥" JPY; null when nothing matches.
  const CURRENCY_RULES = [
    [/\b(USD|EUR|GBP|KRW|JPY|CNY|HKD|TWD|AUD|CAD|NZD|SGD|CHF|INR|THB|VND|RUB|TRY|PLN|BRL|MXN|SEK|NOK|DKK|IDR|MYR|PHP|ZAR|AED|SAR|UAH)\b/i, null],
    [/\bRMB\b|人民币|元/, 'CNY'], [/US\$/i, 'USD'], [/C\$|CA\$/i, 'CAD'], [/A\$|AU\$/i, 'AUD'], [/HK\$/i, 'HKD'],
    [/NT\$/i, 'TWD'], [/S\$/i, 'SGD'], [/NZ\$/i, 'NZD'], [/R\$/, 'BRL'], [/zł/i, 'PLN'],
    [/£/, 'GBP'], [/€/, 'EUR'], [/₩|원/, 'KRW'], [/円|¥|￥/, 'JPY'], [/₹/, 'INR'], [/₽/, 'RUB'], [/₫/, 'VND'],
    [/฿/, 'THB'], [/₺/, 'TRY'], [/₴/, 'UAH'], [/\$/, 'USD'],
  ];
  const toCurrency = (v) => {
    if (v == null || v === '') return null;
    const s = String(v);
    for (const [re, code] of CURRENCY_RULES) { const m = s.match(re); if (m) return code || m[1].toUpperCase(); }
    return null;
  };
  // transform: "clean_url" — drop tracking parameters (utm_*, fbclid, gclid…) and keep everything else, so the same
  // page shared from two places dedupes to one link. A relative URL stays relative.
  const TRACKING_PARAM = /^(?:utm_[a-z_]+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|yclid|twclid|mc_cid|mc_eid|igshid|igsh|_hsenc|_hsmi|mkt_tok|ref_src)$/i;
  const cleanUrl = (v) => {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    let u;
    try { u = new URL(s, 'http://relative.invalid'); } catch (e) { return v; }
    const keep = [...u.searchParams].filter(([k]) => !TRACKING_PARAM.test(k));
    if (keep.length === [...u.searchParams].length) return s;
    u.search = new URLSearchParams(keep).toString();
    const out = u.href;
    return /^[a-z][a-z\d+.-]*:|^\/\//i.test(s) ? out : out.slice('http://relative.invalid'.length);
  };
  // Relative times ("5시간 전", "3 hours ago", "5h", "어제") for transform "date": a Date measured back from
  // `now`, or { daysAgo } when only the day is known. null when the text is not a relative time.
  const RELATIVE_UNITS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
  const relativeTime = (str, now) => {
    const s = str.trim().toLowerCase();
    if (/^(?:just now|now|방금(?: 전)?|조금 전|刚刚|たった今)$/.test(s)) return new Date(now);
    const day = { 오늘: 0, today: 0, 今日: 0, 今天: 0, 어제: 1, yesterday: 1, 昨日: 1, 昨天: 1, 그저께: 2, 그제: 2, 'day before yesterday': 2, 一昨日: 2, 前天: 2 }[s];
    if (day !== undefined) return { daysAgo: day };
    const unit = (u) => {
      if (/^(?:s|secs?|seconds?|초|秒)$/.test(u)) return 's';
      if (/^(?:m|mins?|minutes?|분|分|分钟)$/.test(u)) return 'm';
      if (/^(?:h|hrs?|hours?|시간|時間|小时)$/.test(u)) return 'h';
      if (/^(?:d|days?|일|日|天)$/.test(u)) return 'd';
      if (/^(?:w|wks?|weeks?|주|週間|周)$/.test(u)) return 'w';
      if (/^(?:mo|mos|months?|개월|달|か月|ヶ月|个月)$/.test(u)) return 'mo';
      if (/^(?:y|yrs?|years?|년|年)$/.test(u)) return 'y';
      return null;
    };
    const m = s.match(/^(\d+|an?|one)\s*([a-z가-힣぀-ヿ一-鿿]+?)\s*(ago|전|前)?$/);
    if (!m) return null;
    const u = unit(m[2]);
    // "5 minutes" with no "ago" is a duration, not a time; only the short feed forms (5m, 3h, 2d) stand alone.
    if (!u || (!m[3] && !/^(?:s|m|h|d|w|mo|y)$/.test(m[2]))) return null;
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
    const d = new Date(now);
    if (u === 'mo') d.setMonth(d.getMonth() - n);
    else if (u === 'y') d.setFullYear(d.getFullYear() - n);
    else d.setTime(d.getTime() - n * RELATIVE_UNITS[u]);
    return d;
  };
  // transform: "date" — same rule as toLocalTime in lib.mjs: epoch numbers and zoned ISO text → tz (default
  // Asia/Seoul) "YYYY-MM-DD HH:mm:ss"; relative text ("5시간 전", "3 hours ago", "5h") is measured back from now
  // and "어제"/"yesterday" give the date only; zone-less text keeps its wall-clock fields; non-dates come back unchanged.
  const toLocalTime = (v, tz = 'Asia/Seoul', now = Date.now()) => {
    if (v == null || v === '') return null;
    const str = String(v).trim();
    const z = (n) => String(n).padStart(2, '0');
    const inTz = (d) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
    let d;
    if (typeof v === 'number' || /^\d{9,}(\.\d+)?$/.test(str)) {
      let n = Number(v);
      if (n < 1e11) n *= 1000; else if (n > 1e14) n /= 1000;
      d = new Date(n);
    } else {
      const rel = relativeTime(str, now);
      if (rel && rel.daysAgo !== undefined) { const p = inTz(new Date(now - rel.daysAgo * 864e5)); return `${p.year}-${p.month}-${p.day}`; }
      if (rel) d = rel;
      else {
        const local = str.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(:\d{2})?(?:\.\d+)?)?$/);
        if (local) return local[2] ? `${local[1]} ${local[2]}${local[3] || ':00'}` : local[1];
        d = new Date(str);
        if (Number.isNaN(d.getTime())) return v;
        if (!/(Z|GMT|UTC|[+-]\d{2}:?\d{2})\s*$/i.test(str) && !/\s[+-]\d{4}\s|\b(?:GMT|UTC)\b/i.test(str)) return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
      }
    }
    if (Number.isNaN(d.getTime())) return v;
    const part = inTz(d);
    return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}:${part.second}`;
  };
  const value = (e, spec) => {
    let v;
    if (!spec.attr || spec.attr === 'text') v = norm(textOf(e));
    else if (spec.attr === 'html') v = e.innerHTML;
    else v = e.getAttribute(spec.attr);
    if (v == null) return null;
    const urlish = spec.attr && /^(href|src|data-src|data-href|action|poster)$/.test(spec.attr);
    if (spec.absolute || (urlish && spec.absolute !== false)) {
      try {
        v = new URL(v, location.href).href;
      } catch (e2) {
        /* leave as is */
      }
    }
    if (spec.regex) {
      const m = String(v).match(new RegExp(spec.regex, spec.regex_flags || ''));
      v = m ? (m[1] !== undefined ? m[1] : m[0]) : null;
    }
    // map: { "One": 1, "Two": 2 } — star ratings in class names, status words, etc. Unknown values pass through.
    if (spec.map && v != null && Object.prototype.hasOwnProperty.call(spec.map, String(v))) v = spec.map[String(v)];
    if (v != null && spec.transform === 'number') {
      const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
      v = Number.isNaN(n) ? null : n;
    }
    if (v != null && spec.transform === 'trim') v = norm(v);
    if (v != null && spec.transform === 'date') v = toLocalTime(v, spec.tz);
    if (v != null && spec.transform === 'price') v = toPrice(v);
    if (v != null && spec.transform === 'currency') v = toCurrency(v);
    if (v != null && spec.transform === 'clean_url') v = cleanUrl(v);
    return v;
  };
  // Resolve a field selector inside a scope. ":scope" = the container itself.
  // A leading "+ " looks in the container's next sibling element instead ("++ " = the one after that):
  // two-row tables like Hacker News keep the title in one <tr> and the score in the next.
  const resolve = (sel, scope) => {
    if (!sel || sel === ':scope') return scope === document ? [document.documentElement] : [scope];
    let s = sel;
    let sc = scope;
    const m = s.match(/^(\++)\s*(.*)$/);
    if (m && sc !== document) {
      for (let i = 0; i < m[1].length && sc; i++) sc = sc.nextElementSibling;
      if (!sc) return [];
      s = m[2];
      if (!s) return [sc];
    }
    return qsa(s, sc === document ? document : sc);
  };
  S.resolve = resolve;
  S.count = (sel) => qsa(sel).length; // what the collector counts while scrolling, shadow roots included
  // fields: { name: 'css' | { selector, attr, all, join, regex, map, transform: 'number'|'trim'|'count'|'date'|'price'|'currency'|'clean_url', tz, absolute } | { template } }
  // container: css for each item (one row per match). Omit for a single-row page.
  S.extract = (fields, container) => {
    const scopes = container ? qsa(container) : [document];
    const rows = [];
    for (const sc of scopes) {
      const row = {};
      let any = false;
      for (const [name, raw] of Object.entries(fields || {})) {
        const spec = typeof raw === 'string' ? { selector: raw } : raw || {};
        if (spec.template != null) { row[name] = null; continue; } // filled below from the other columns
        const els = resolve(spec.selector, sc);
        // transform: "count" — the value is how many elements match (star icons, badges, thumbnails), not their text
        if (spec.transform === 'count') {
          row[name] = els.length;
          if (els.length) any = true;
          continue;
        }
        if (spec.all) {
          const arr = els.map((e) => value(e, spec)).filter((v) => v != null && v !== '');
          // join: "\n\n" turns the paragraphs of an article body into one text cell instead of an array
          row[name] = spec.join != null ? arr.join(spec.join) : arr;
        } else row[name] = els.length ? value(els[0], spec) : null;
        if (row[name] != null && row[name] !== '' && !(Array.isArray(row[name]) && !row[name].length)) any = true;
      }
      // template: "https://site/item/{id}" — same rule as finishRows in lib.mjs (empty if a placeholder is empty)
      for (const [name, raw] of Object.entries(fields || {})) {
        if (typeof raw?.template !== 'string') continue;
        let missing = false;
        const v = raw.template.replace(/\{([^{}]+)\}/g, (_, k) => {
          const x = row[k];
          if (x == null || x === '' || (Array.isArray(x) && !x.length)) { missing = true; return ''; }
          return String(x);
        });
        row[name] = missing ? null : v;
      }
      if (any || !container) rows.push(row);
    }
    return rows;
  };

  // ---------- probing ----------
  // opts.within = container selector; the probe then runs inside EVERY container (so count ≈ item count means a good field).
  S.probe = (selector, opts = {}) => {
    const scopes = opts.within ? qsa(opts.within) : [document];
    const els = scopes.flatMap((sc) => resolve(selector, sc));
    const texts = els.slice(0, opts.limit || 5).map((e) => cut(norm(e.textContent), 100));
    const attrs = {};
    for (const e of els.slice(0, 20)) for (const a of e.getAttributeNames()) attrs[a] = (attrs[a] || 0) + 1;
    // Icons, stars and status badges carry their value in the class name, not in text; show the distinct classes
    // so an "empty" selector is recognised as attr: "class" + regex/map material instead of a dead end.
    const classes = [...new Set(els.slice(0, 40).map((e) => e.getAttribute('class') || '').filter(Boolean))].slice(0, 6);
    return {
      selector,
      count: els.length,
      visible: els.filter(isVisible).length,
      distinct_texts: new Set(els.map((e) => norm(e.textContent))).size,
      samples: texts,
      attrs: Object.keys(attrs).filter((a) => a !== 'class' && a !== 'style').slice(0, 12),
      classes,
      hint: texts.every((t) => !t) && classes.length > 1 ? 'no text; the value is probably in the class name — use attr: "class" with regex or map' : undefined,
    };
  };

  // Reverse lookup: "the price looks like 39,000원" -> where is it, and is it part of a list?
  S.findByText = (sample, opts = {}) => {
    const q = norm(sample);
    if (!q) return [];
    const qd = digits(q);
    const numeric = qd.length >= 2 && qd.length >= q.replace(/\s/g, '').length * 0.5;
    const hits = [];
    const matches = (t) => t.includes(q) || (numeric && digits(t).includes(qd));
    for (const el of allUnder(document.body)) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      const t = norm(el.textContent);
      if (!t || t.length > q.length * 6 + 60) continue; // too broad; a descendant will match instead
      if (!matches(t)) continue;
      if ([...el.children].some((c) => matches(norm(c.textContent)))) continue; // keep the deepest
      hits.push({ el, kind: 'text' });
      if (hits.length >= 60) break;
    }
    // attribute matches (title="...", alt, value, content, href)
    if (hits.length < 10) {
      for (const e of allUnder(document.body).filter((x) => x.matches('[title],[alt],[value],[content],[aria-label],[href],[data-price],[data-value]'))) {
        for (const a of e.getAttributeNames()) {
          if (a === 'class' || a === 'style' || a.startsWith('on')) continue;
          const v = e.getAttribute(a) || '';
          if (v.length < 300 && matches(norm(v))) {
            hits.push({ el: e, kind: 'attr', attr: a });
            break;
          }
        }
        if (hits.length >= 60) break;
      }
    }
    return hits.slice(0, opts.max || 8).map(({ el: e, kind, attr }) => {
      const unique = cssPath(e);
      const general = generalize(unique);
      const genCount = qsa(general).length;
      const res = {
        match: kind === 'attr' ? `attribute ${attr}` : 'text',
        text: cut(kind === 'attr' ? e.getAttribute(attr) : norm(e.textContent), 120),
        tag: tag(e),
        selector: unique,
        visible: isVisible(e),
        attrs: Object.fromEntries(
          e.getAttributeNames().filter((a) => !['class', 'style'].includes(a) && !a.startsWith('on')).slice(0, 6).map((a) => [a, cut(e.getAttribute(a), 80)])
        ),
      };
      if (kind === 'attr') res.attr = attr;
      const item = itemAncestor(e);
      if (item) {
        const container = itemSelector(item);
        const field = pathWithin(e, item.itemEl);
        res.list = {
          container,
          item_count: item.count,
          field_selector: field,
          field_matches_in_items: qsa(container).filter((it) => qsa(field, it).length).length,
          recipe_hint: { container, field: field.replace(/^:scope(?: > | )/, '') },
        };
      } else if (genCount > 1) res.repeats = { selector: general, count: genCount };
      return res;
    });
  };

  // Repeating structures = candidate lists (product grids, article lists, tables).
  S.detectLists = (opts = {}) => {
    const min = opts.min || 3;
    const out = [];
    const seen = new Set();
    for (const parent of allUnder(document.body)) {
      if (SKIP_TAGS.has(parent.tagName) || parent.children.length < min) continue;
      if (parent.closest('nav, header, footer, [role="navigation"], [role="menu"], select, [aria-hidden="true"]')) continue;
      const groups = {};
      for (const c of parent.children) {
        if (SKIP_TAGS.has(c.tagName) || c.tagName === 'BR') continue;
        (groups[signature(c)] ||= []).push(c);
      }
      for (const [sig, items] of Object.entries(groups)) {
        if (items.length < min) continue;
        const key = cssPath(parent) + '|' + sig;
        if (seen.has(key)) continue;
        seen.add(key);
        const texts = items.map((i) => norm(textOf(i)));
        const avgLen = texts.reduce((a, t) => a + Math.min(t.length, 400), 0) / items.length;
        if (avgLen < 8) continue; // icon rows, pagination dots, etc.
        const distinct = new Set(texts).size / items.length;
        const visible = items.filter(isVisible).length / items.length;
        const links = items.filter((i) => i.matches('a[href], tr') || i.querySelector('a[href]')).length / items.length;
        const score = Math.round(items.length * Math.min(avgLen, 200) * (0.3 + 0.7 * distinct) * (0.2 + 0.8 * visible) * (0.6 + 0.4 * links));
        out.push({ parent, items, score, avgLen, visible });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, opts.limit || 5).map(({ parent, items, score }) => {
      const container = listSelector(parent, items);
      return {
        container,
        count: items.length,
        matches: qsa(container).length,
        score,
        sample: cut(norm(textOf(items[0])), 160),
        fields: fieldCandidates(items),
      };
    });
  };
  // Leaf elements of item[0] whose relative selector also exists in items[1..2] with different text => data fields.
  const fieldCandidates = (items) => {
    const first = items[0];
    const probe = items.slice(1, 4);
    const leaves = allUnder(first).filter((e) => !SKIP_TAGS.has(e.tagName) && (e.children.length === 0 || e.matches('a, img, time, button')) && (norm(e.textContent) || e.matches('img, a[href], time[datetime]')));
    const res = [];
    const seenSel = new Set();
    for (const e of leaves.slice(0, 60)) {
      const rel = pathWithin(e, first).replace(/^:scope(?: > | )/, '');
      if (seenSel.has(rel)) continue;
      seenSel.add(rel);
      const samples = [e, ...probe.map((it) => qsa(rel, it)[0])].map((x) => (x ? cut(norm(x.textContent) || x.getAttribute('alt') || x.getAttribute('href') || '', 60) : null));
      const present = samples.filter((s) => s != null).length;
      if (present < Math.min(2, probe.length + 1)) continue;
      const entry = { selector: rel, tag: tag(e), samples };
      if (e.matches('a[href]')) entry.href = cut(e.getAttribute('href'), 80);
      if (e.matches('img')) entry.src = cut(e.getAttribute('src') || e.getAttribute('data-src') || '', 80);
      if (e.matches('time[datetime]')) entry.datetime = e.getAttribute('datetime');
      res.push(entry);
      if (res.length >= (12)) break;
    }
    return res;
  };

  // ---------- recipe self-repair: fingerprints and relocation ----------
  // A healthy run remembers what each field's element looks like (fingerprint). When a redesign breaks a selector,
  // every element in the items is scored against that memory and the best place is PROPOSED with samples; nothing
  // here changes a recipe. Inspired by Scrapling's adaptive tracking, but the person confirms before it is applied.
  const STABLE_ATTRS = ['itemprop', 'data-testid', 'data-test', 'data-qa', 'data-cy', 'name', 'role', 'rel', 'type', 'aria-label'];
  const stableClasses = (el) => [...el.classList].filter((c) => !hashy(c) && !STATE_CLASS.test(c));
  // What kind of value a field holds, so a moved price is not "repaired" onto a nearby "In stock" label.
  const kindOf = (v) => {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return 'empty';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'boolean') return 'bool';
    const s = norm(Array.isArray(v) ? v.join(' ') : v);
    if (/^(https?:)?\/\/\S+$|^\/\S*$/.test(s)) return 'url';
    if (s.length < 30 && /\d/.test(s) && /[£€$¥￥₩₹₽₫฿원円元]|\b[A-Z]{3}\s?\d/.test(s)) return 'price';
    if (s.length < 40 && /^\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|\b(?:ago|yesterday)\b|(?:전|前)$/.test(s)) return 'date';
    if (/^[-+]?[\d.,\s%]+$/.test(s)) return 'number';
    return s.length > 80 ? 'longtext' : 'text';
  };
  const elPrint = (el, root) => {
    const chain = [];
    for (let cur = el; cur && cur !== root && cur.nodeType === 1; cur = cur.parentElement) chain.unshift(tag(cur));
    const p = el.parentElement;
    const keyAttrs = {};
    for (const a of STABLE_ATTRS) { const v = el.getAttribute(a); if (v != null && v.length < 60) keyAttrs[a] = v; }
    return {
      tag: tag(el),
      classes: stableClasses(el).slice(0, 6),
      attrs: el.getAttributeNames().filter((a) => !/^(class|style|id)$/.test(a)).sort().slice(0, 12),
      keyAttrs,
      path: chain.slice(-6),
      parent: p && p !== root ? { tag: tag(p), classes: stableClasses(p).slice(0, 4) } : null,
      siblings: p ? [...new Set([...p.children].filter((c) => c !== el).map(tag))].slice(0, 8) : [],
    };
  };
  const jaccard = (a = [], b = []) => {
    if (!a.length && !b.length) return 1;
    const A = new Set(a);
    return b.filter((x) => A.has(x)).length / new Set([...a, ...b]).size;
  };
  const lcsRatio = (a = [], b = []) => {
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    return dp[a.length][b.length] / Math.max(a.length, b.length, 1);
  };
  // 0..1: how much a candidate element looks like the remembered one (structure only; values are scored apart).
  const structScore = (pr, fp) => {
    const keys = Object.keys(fp.keyAttrs || {});
    const key = keys.length ? keys.filter((k) => pr.keyAttrs[k] === fp.keyAttrs[k]).length / keys.length : Object.keys(pr.keyAttrs).length ? 0.5 : 1;
    const parent = !pr.parent && !fp.parent ? 1 : !pr.parent || !fp.parent ? 0 : 0.5 * (pr.parent.tag === fp.parent.tag) + 0.5 * jaccard(pr.parent.classes, fp.parent.classes);
    return 0.2 * (pr.tag === fp.tag) + 0.25 * jaccard(pr.classes, fp.classes) + 0.1 * jaccard(pr.attrs, fp.attrs) + 0.15 * key
      + 0.1 * lcsRatio(pr.path, fp.path) + 0.1 * parent + 0.1 * jaccard(pr.siblings, fp.siblings);
  };
  const fieldSpec = (raw) => (typeof raw === 'string' ? { selector: raw } : raw || {});
  // Fields a fingerprint can stand for: one element inside the item, found by a selector.
  const repairable = (spec) => typeof spec.selector === 'string' && spec.template == null && spec.transform !== 'count' && !spec.all && !/^\+/.test(spec.selector) && spec.selector !== ':scope';
  const valuesOf = (spec, sel, items) => items.map((it) => { const e = resolve(sel, it)[0]; return e ? value(e, spec) : null; });
  // The kind is read before the transform: "Book number 1" through transform "price" is the number 1, but the text
  // is still a title, not a price. regex/map stay, so a star rating read from a class keeps its kind.
  const rawKind = (e, spec) => kindOf(value(e, { ...spec, transform: undefined }));
  const kindsOf = (spec, sel, items) => items.map((it) => { const e = resolve(sel, it)[0]; return e ? rawKind(e, spec) : 'empty'; }).filter((k) => k !== 'empty');
  const specificity = (sel) => (sel.match(/[.#[]/g) || []).length;
  const filled = (vals) => vals.filter((v) => v != null && v !== '').length;
  const SPECIFIC_KINDS = new Set(['price', 'number', 'date', 'url']);

  // fingerprint(fields, container) → what each healthy field (filled in >= min_fill of the items) looks like now.
  S.fingerprint = (fields, container, opts = {}) => {
    const items = container ? qsa(container) : [];
    if (!items.length) return null;
    const minFill = opts.min_fill ?? 0.9;
    const out = { container: { selector: container, count: items.length, ...elPrint(items[0], items[0].parentElement && items[0].parentElement.parentElement) }, fields: {} };
    for (const [name, raw] of Object.entries(fields || {})) {
      const spec = fieldSpec(raw);
      if (!repairable(spec)) continue;
      const vals = valuesOf(spec, spec.selector, items);
      if (filled(vals) / items.length < minFill) continue;
      const first = items.map((it) => resolve(spec.selector, it)[0]).find(Boolean);
      const kinds = {};
      for (const k of kindsOf(spec, spec.selector, items)) kinds[k] = (kinds[k] || 0) + 1;
      out.fields[name] = {
        selector: spec.selector,
        attr: spec.attr || 'text',
        kind: Object.entries(kinds).sort((a, b) => b[1] - a[1])[0][0],
        examples: [...new Set(vals.filter((v) => v != null && v !== '').map((v) => cut(String(v), 80)))].slice(0, 5),
        print: elPrint(first, items[items.indexOf(first.closest(container))] || first.parentElement),
      };
    }
    return out;
  };

  const relocateFields = (fields, items, saved, opts) => {
    const threshold = opts.threshold ?? 0.55;
    const brokenBelow = opts.broken_below ?? 0.5;
    const out = {};
    const sample = items.slice(0, 8);
    for (const [name, raw] of Object.entries(fields || {})) {
      const spec = fieldSpec(raw);
      if (!repairable(spec)) continue;
      const fill = filled(valuesOf(spec, spec.selector, items)) / (items.length || 1);
      if (fill >= brokenBelow) { out[name] = { status: 'ok', selector: spec.selector, fill: Math.round(fill * 100) / 100 }; continue; }
      const fp = saved && saved.fields && saved.fields[name];
      if (!fp) { out[name] = { status: 'lost', selector: spec.selector, fill, reason: 'no fingerprint (never seen healthy)' }; continue; }
      const cands = new Map(); // relative selector → best structure score among the elements it came from
      for (const el of sample.length ? allUnder(sample[0]) : []) {
        if (SKIP_TAGS.has(el.tagName)) continue;
        if (fp.attr && !/^(text|html)$/.test(fp.attr) && !el.hasAttribute(fp.attr)) continue;
        const v0 = value(el, spec);
        if (v0 == null || v0 === '') continue;
        const st = structScore(elPrint(el, sample[0]), fp.print);
        if (st < 0.25) continue;
        const full = pathWithin(el, sample[0]).replace(/^:scope(?: > | )/, '');
        const anchored = el.parentElement && el.parentElement !== sample[0] ? `${ident(el.parentElement)} ${ident(el)}` : null;
        for (const sel of new Set([full, generalize(full), ident(el), anchored].filter(Boolean))) if (!cands.has(sel) || cands.get(sel) < st) cands.set(sel, st);
      }
      let best = null;
      for (const [sel, st] of cands) {
        const vals = valuesOf(spec, sel, items);
        const got = vals.filter((v) => v != null && v !== '');
        if (!got.length) continue;
        const coverage = got.length / items.length;
        const kinds = kindsOf(spec, sel, items);
        const kindMatch = kinds.length ? kinds.filter((k) => k === fp.kind).length / kinds.length : 0;
        if (SPECIFIC_KINDS.has(fp.kind) && kindMatch < 0.6) continue; // a price must still look like a price
        // a field that used to differ per item (titles) must not be mapped onto something constant (a label)
        if ((fp.examples || []).length > 1 && items.length > 2 && new Set(got.map(String)).size === 1) continue;
        const exampleHit = got.some((v) => (fp.examples || []).includes(cut(String(v), 80))) ? 1 : 0;
        const score = 0.45 * st + 0.25 * coverage + 0.2 * kindMatch + 0.1 * exampleHit;
        // equal scores: the more anchored selector ("h2.title a" over "a") survives the next unrelated link
        if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && specificity(sel) > specificity(best.selector))) best = { selector: sel, score, coverage, samples: got.slice(0, 3) };
      }
      if (best && best.score >= threshold && best.coverage >= 0.6) {
        out[name] = { status: 'moved', old: spec.selector, selector: best.selector, score: Math.round(best.score * 100) / 100, fill: Math.round(best.coverage * 100) / 100, samples: best.samples };
      } else out[name] = { status: 'lost', selector: spec.selector, fill, best_score: best ? Math.round(best.score * 100) / 100 : 0 };
    }
    return out;
  };

  // relocate(fields, container, saved) → for each field: ok (still works), moved (proposed new selector, score,
  // samples) or lost. When the container itself matches fewer than 2 items, the page's repeated blocks are tried
  // and the one whose fields come back best is proposed as the new container.
  S.relocate = (fields, container, saved, opts = {}) => {
    const threshold = opts.threshold ?? 0.55;
    const items = container ? qsa(container) : [];
    const res = { container: { status: items.length >= 2 ? 'ok' : 'lost', selector: container, count: items.length }, fields: {} };
    if (items.length >= 2 || !saved || !saved.container) {
      res.fields = relocateFields(fields, items, saved, opts);
      return res;
    }
    let best = null;
    for (const list of S.detectLists({ limit: 8 })) {
      const its = qsa(list.container);
      if (its.length < 2) continue;
      const cs = structScore(elPrint(its[0], its[0].parentElement && its[0].parentElement.parentElement), saved.container);
      const f = relocateFields(fields, its, saved, opts);
      const names = Object.keys(f);
      const found = names.length ? names.filter((n) => f[n].status !== 'lost').length / names.length : 0;
      const score = 0.3 * cs + 0.7 * found;
      if (!best || score > best.score) best = { selector: list.container, count: its.length, score, f };
    }
    if (best && best.score >= threshold) {
      res.container = { status: 'moved', old: container, selector: best.selector, count: best.count, score: Math.round(best.score * 100) / 100 };
      res.fields = best.f;
    } else res.fields = relocateFields(fields, [], saved, opts);
    return res;
  };
  S.kindOf = kindOf;

  // ---------- embedded data (JSON the page already ships) ----------
  const shape = (v, depth = 2) => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return depth <= 0 ? `array(${v.length})` : { [`array(${v.length})`]: v.length ? shape(v[0], depth - 1) : 'empty' };
    if (typeof v === 'object') {
      const keys = Object.keys(v);
      if (depth <= 0) return `object{${keys.slice(0, 8).join(',')}${keys.length > 8 ? ',…' : ''}}`;
      const o = {};
      for (const k of keys.slice(0, 25)) o[k] = shape(v[k], depth - 1);
      if (keys.length > 25) o['…'] = `${keys.length - 25} more keys`;
      return o;
    }
    if (typeof v === 'string') return `string "${cut(v, 40)}"`;
    return typeof v + ' ' + String(v);
  };
  // path grammar: a.b[0].c   and a trailing/inner [] to iterate (used by collect.mjs for items.path)
  // ["key.with.dots"] (or ['…']) addresses a key that holds dots or brackets; \" and \\ escape inside. Same as lib.mjs.
  // "[*]" iterates an object's values; a path that meets a string holding JSON keeps going inside it.
  const ITER = Symbol('[]');
  const VALUES = Symbol('[*]');
  const pathSegments = (path) => {
    const segs = [];
    const re = /\[\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*\]|\[(\d+)\]|\[\*\]|\[\]|([^.[\]]+)/g;
    for (const m of path.matchAll(re)) {
      if (m[1]) segs.push(m[2].replace(/\\(.)/g, '$1'));
      else if (m[3] !== undefined) segs.push(m[3]);
      else if (m[4] !== undefined) segs.push(m[4]);
      else segs.push(m[0] === '[*]' ? VALUES : ITER);
    }
    return segs;
  };
  let lastJsonText, lastJsonValue;
  const parseJsonString = (str) => {
    if (str === lastJsonText) return lastJsonValue;
    const t = str.trimStart();
    if (t[0] !== '{' && t[0] !== '[') return undefined;
    try { lastJsonValue = JSON.parse(str); lastJsonText = str; return lastJsonValue; } catch (e) { return undefined; }
  };
  const walkPath = (obj, segs) => {
    let cur = obj;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (cur == null) return undefined;
      if (typeof cur === 'string') { cur = parseJsonString(cur); if (cur === undefined) return undefined; }
      if (s === ITER || s === VALUES) {
        const rest = segs.slice(i + 1);
        if (Array.isArray(cur)) return cur.map((x) => walkPath(x, rest));
        if (typeof cur !== 'object') return undefined;
        return s === VALUES ? Object.values(cur).map((x) => walkPath(x, rest)) : [walkPath(cur, rest)]; // one object = a one-item list
      }
      cur = cur[s];
    }
    return cur;
  };
  const getPath = (obj, path) => (!path || path === '$' ? obj : walkPath(obj, pathSegments(path)));
  const WINDOW_STATE_KEYS = ['__NEXT_DATA__', '__NUXT__', '__INITIAL_STATE__', '__PRELOADED_STATE__', '__APOLLO_STATE__', '__remixContext', '__INITIAL_DATA__', '__DATA__', '__STATE__', '__PRELOADED__', '__reactRouterContext', '__staticRouterHydrationData', 'dataLayer'];
  const embeddedSources = () => {
    const src = {};
    const nd = document.querySelector('script#__NEXT_DATA__');
    if (nd) {
      try {
        src.next = JSON.parse(nd.textContent);
      } catch (e) {
        /* ignore */
      }
    }
    for (const k of WINDOW_STATE_KEYS) {
      if (k === '__NEXT_DATA__' && src.next) continue;
      try {
        const v = window[k];
        if (v && typeof v === 'object') src['window:' + k] = v;
      } catch (e) {
        /* cross-origin or getter */
      }
    }
    const ld = [];
    for (const s of qsa('script[type="application/ld+json"]')) {
      try {
        ld.push(JSON.parse(s.textContent));
      } catch (e) {
        /* ignore */
      }
    }
    if (ld.length) src.ldjson = ld;
    return src;
  };
  S.embedded = () => {
    const src = embeddedSources();
    const out = {};
    for (const [k, v] of Object.entries(src)) {
      if (k === 'next') out.next = { note: 'script#__NEXT_DATA__; data usually under props.pageProps', shape: shape(v.props && v.props.pageProps ? v.props.pageProps : v, 2) };
      else if (k === 'ldjson') out.ldjson = v.map((x) => (Array.isArray(x) ? x.map((y) => y['@type']) : x['@type'] || Object.keys(x).slice(0, 5)));
      else out[k] = shape(v, 2);
    }
    // large inline JSON assigned to a global we did not list
    const inline = qsa('script:not([src])')
      .map((s) => s.textContent || '')
      .filter((t) => t.length > 2000 && !t.includes('window.__scrape') && /(window\.|var |let |const )\s*[\w$.]+\s*=\s*[\[{]/.test(t))
      .map((t) => cut((t.match(/(window\.|var |let |const )\s*([\w$.]+)\s*=/) || [])[0] || '', 60));
    if (inline.length) {
      out.inline_json_candidates = inline.slice(0, 6);
      out.inline_json_hint = "read one with embeddedGet('window:NAME') (works for any global) or embeddedGet({ regex: 'var NAME = (\\\\[[\\\\s\\\\S]*?\\\\]);' })";
    }
    return Object.keys(out).length ? out : { none: true };
  };
  // source: 'next' | 'window:__INITIAL_STATE__' | 'ldjson' ; path as in getPath. Returns a truncated JSON view.
  // source: 'next' | 'ldjson' | 'window:NAME' (any global object, not only the known list) |
  // { regex, flags } — group 1 of the match against the page HTML, parsed as JSON; the same meaning as
  // lib.mjs extractEmbedded, so the `embedded` strategy's inline script assignment (`var NAME = …`) can be previewed here.
  S.embeddedGet = (source, path, opts = {}) => {
    const src = embeddedSources();
    let root = typeof source === 'string' ? src[source] : undefined;
    if (root === undefined && typeof source === 'string' && source.startsWith('window:')) {
      try { const v = window[source.slice(7)]; if (v && typeof v === 'object') root = v; } catch (e) { /* getter threw */ }
    }
    if (root === undefined && source && typeof source === 'object' && source.regex) {
      // Scan the page's own HTML without the helpers.js copy that addScriptTag appended to <head>; that copy
      // sits before the body and would be the first (decoy) match for a pattern like `var NAME = (…)`.
      const own = [...document.querySelectorAll('script:not([src])')].filter((s) => (s.textContent || '').includes('window.__scrape'));
      const haystack = own.reduce((h, s) => h.replace(s.outerHTML, ''), document.documentElement.outerHTML);
      let m;
      try { m = haystack.match(new RegExp(source.regex, source.flags || '')); } catch (e) { return { error: 'bad regex: ' + e.message }; }
      if (!m) return { error: 'regex did not match the page HTML' };
      const cap = m[1] !== undefined ? m[1] : m[0];
      try { root = JSON.parse(cap); } catch (e) { return { error: 'regex capture is not valid JSON', capture_start: cut(cap, 120) }; }
    }
    if (root === undefined) return { error: `no source ${typeof source === 'string' ? source : JSON.stringify(source)}`, available: Object.keys(src), hint: "any global works as 'window:NAME'; for an inline script assignment use { regex: 'var NAME = (\\\\[[\\\\s\\\\S]*?\\\\]);' } with the real name" };
    const v = getPath(root, path || '');
    const json = JSON.stringify(v);
    return { path: path || '$', shape: shape(v, opts.depth || 2), json: json == null ? null : cut(json, opts.max || 3000), length: json ? json.length : 0 };
  };
  S.getPath = getPath;
  S.toLocalTime = toLocalTime;
  S.toPrice = toPrice;
  S.toCurrency = toCurrency;
  S.cleanUrl = cleanUrl;

  // ---------- pagination / API hints / diagnosis ----------
  S.pagination = () => {
    const res = {};
    const next = document.querySelector('a[rel~="next"], link[rel~="next"]');
    if (next) res.rel_next = { href: next.getAttribute('href'), selector: next.tagName === 'A' ? cssPath(next) : 'link[rel=next]' };
    const NEXT_TXT = /^(next|next page|다음|다음 페이지|다음페이지|›|»|>|→|more|load more|show more|더보기|더 보기|see more|older|이전글)$/i;
    // "Next →", "다음 ›", "» Next": decorative arrows around the word defeat a whole-string match, so test the
    // text both as-is (arrow-only links) and with leading/trailing arrows stripped, and accept a leading "next".
    const stripArrows = (t) => t.replace(/^[›»→←‹«<>\s]+/, '').replace(/[›»→←‹«<>\s]+$/, '');
    const nextLike = qsa('a, button').filter((a) => {
      const raw = norm(a.textContent);
      const t = stripArrows(raw);
      return NEXT_TXT.test(raw) || NEXT_TXT.test(t) || /^next\b/i.test(t) || /next|다음|more|더보기/i.test(a.getAttribute('aria-label') || '');
    });
    if (nextLike.length) res.next_like = nextLike.slice(0, 3).map((a) => ({ text: cut(norm(a.textContent) || a.getAttribute('aria-label'), 30), selector: cssPath(a), href: a.getAttribute('href') }));
    const params = {};
    const pathPatterns = new Set();
    for (const a of qsa('a[href]').slice(0, 1500)) {
      let u;
      try {
        u = new URL(a.getAttribute('href'), location.href);
      } catch (e) {
        continue;
      }
      if (u.origin !== location.origin) continue;
      for (const [k, v] of u.searchParams) if (/^(page|p|pg|pageno|pagenum|page_no|pagenumber|offset|start|skip|cursor|pageindex|currentpage)$/i.test(k) && /^\d+$/.test(v)) (params[k] ||= new Set()).add(v);
      const m = u.pathname.match(/\/(page|p)[-\/_](\d+)|[-_](\d+)\.html?$/i);
      if (m) {
        // Replace only the page number the regex matched, not the first digits in the path:
        // /books/mystery_3/page-2.html must become .../mystery_3/page-{n}.html, not mystery_{n}/page-2.html.
        const num = m[2] || m[3];
        const at = m.index + m[0].lastIndexOf(num);
        pathPatterns.add(u.pathname.slice(0, at) + '{n}' + u.pathname.slice(at + num.length));
      }
    }
    if (Object.keys(params).length) res.page_params = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, [...v].slice(0, 6)]));
    if (pathPatterns.size) res.path_patterns = [...pathPatterns].slice(0, 4);
    const se = document.scrollingElement || document.documentElement;
    res.scroll = { page_height: se.scrollHeight, viewport: innerHeight, long_page: se.scrollHeight > innerHeight * 2.5 };
    if (!res.rel_next && !res.page_params && !res.path_patterns && res.scroll.long_page) res.maybe_infinite_scroll = true;
    return res;
  };
  const NOISE = /google|gstatic|doubleclick|facebook|fbcdn|analytics|gtm|segment\.|amplitude|mixpanel|hotjar|clarity\.ms|sentry|datadog|newrelic|nr-data|kakao|naver\.com\/(wcs|lcs)|criteo|adsrvr|taboola|outbrain|cloudflareinsights|bat\.bing|tiktok|snapchat|branch\.io|appsflyer|braze|onesignal|intercom|zendesk|hubspot|optimizely|launchdarkly|chartbeat|scorecard|quantserve|pubmatic|rubicon|openx|adnxs/i;
  S.apiHints = (opts = {}) => {
    const seen = new Set();
    const out = [];
    for (const r of performance.getEntriesByType('resource')) {
      if (!['fetch', 'xmlhttprequest', 'other'].includes(r.initiatorType)) continue;
      if (NOISE.test(r.name) || /\.(png|jpe?g|gif|webp|svg|woff2?|ttf|css|js|ico|mp4|m3u8)(\?|$)/i.test(r.name)) continue;
      const key = r.name.replace(/(\d{6,}|[0-9a-f-]{16,})/g, '{id}');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ url: cut(r.name, 160), type: r.initiatorType, size: r.transferSize || r.encodedBodySize || null });
      if (out.length >= (opts.limit || 20)) break;
    }
    return out;
  };
  // ---------- request origins: which script sends the API call, and where its headers come from ----------
  // apiHints() only knows URLs (performance entries). To learn who builds a request, fetch and XMLHttpRequest
  // are wrapped when the helpers load, and every call is logged with its header NAMES and the top frames of
  // `new Error().stack`. Header VALUES are compared with localStorage / sessionStorage / document.cookie at
  // send time and then dropped; what is kept is the classification and a hash to tell "same every time" from
  // "changes per request".
  // Limits: only requests made after the helpers loaded are seen, so install with addInitScript and reload;
  // pasted through browser_evaluate, the log starts at that moment. The wrapper is deliberately plain (the page
  // can see that fetch is wrapped) — it is an analysis aid, never something to disguise. The collector
  // (collect.mjs) sets window.__scrape_no_net and does not install it at all.
  const PLAIN_HEADER = /^(accept|accept-language|content-type|cache-control|pragma|x-requested-with|if-none-match|if-modified-since|range)$/i;
  const hashOf = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h; };
  const storageEntries = (which) => {
    const out = [];
    try { const area = window[which]; for (let i = 0; i < area.length; i++) { const k = area.key(i); out.push([k, area.getItem(k) || '']); } } catch (e) { /* storage blocked in this frame */ }
    return out;
  };
  // 'storage:<key>' | 'cookie:<name>' | 'computed' for one header value. "computed" = not readable from storage
  // or cookies: built by the page's code (signature, timestamp, nonce), hard-coded in the bundle, or kept in memory.
  const headerOrigin = (raw) => {
    const token = String(raw == null ? '' : raw).replace(/^(bearer|basic|token|jwt)\s+/i, '');
    if (token.length < 6) return { origin: 'computed' };
    const holds = (s) => s === token || (token.length >= 8 && s.includes(token));
    for (const [which, area] of [['localStorage', 'local'], ['sessionStorage', 'session']]) {
      for (const [k, v] of storageEntries(which)) if (k !== S.collectKey && holds(v)) return { origin: 'storage:' + k, area };
    }
    let cookies = '';
    try { cookies = document.cookie || ''; } catch (e) { /* sandboxed document */ }
    for (const part of cookies.split(/;\s*/)) {
      const i = part.indexOf('=');
      if (i < 1) continue;
      const v = part.slice(i + 1);
      let dec = v;
      try { dec = decodeURIComponent(v); } catch (e) { /* not URL-encoded */ }
      if (v.length >= 6 && (holds(v) || holds(dec))) return { origin: 'cookie:' + part.slice(0, i) };
    }
    return { origin: 'computed' };
  };
  const stackFrames = (stack) => {
    const out = [];
    for (const line of String(stack || '').split('\n')) {
      if (line.includes('__scrape')) continue; // our own wrapper frames
      const m = line.match(/((?:https?|file):\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/);
      if (!m) continue;
      const fn = (line.match(/^\s*at (?:async )?([^\s(]+) \(/) || line.match(/^([^@\s]+)@/) || [])[1];
      out.push({ script: m[1].replace(/[?#].*$/, ''), line: Number(m[2]), col: Number(m[3]), fn: fn || undefined });
      if (out.length >= 10) break;
    }
    return out;
  };
  const net = (window.__scrape_net = window.__scrape_net || { log: [], wrapped: false, late: document.readyState !== 'loading' });
  // Re-installing the helpers replaces record() but never wraps twice.
  net.record = function __scrape_record(via, method, url, headers) {
    let abs;
    try { abs = new URL(url, location.href).href; } catch (e) { return; }
    if (NOISE.test(abs)) return;
    net.log.push({
      via,
      method: String(method || 'GET').toUpperCase(),
      url: abs,
      headers: headers.map(([name, value]) => {
        const n = String(name).toLowerCase();
        return PLAIN_HEADER.test(n) ? { name: n, plain: true } : { name: n, ...headerOrigin(value), hash: hashOf(String(value)) };
      }),
      frames: stackFrames(new Error().stack),
    });
    if (net.log.length > 300) net.log.shift();
  };
  if (!net.wrapped && !window.__scrape_no_net) {
    net.wrapped = true;
    if (typeof window.fetch === 'function') {
      const origFetch = window.fetch;
      window.fetch = function __scrape_fetch(input, init) {
        try {
          const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
          const headers = [];
          const add = (h) => {
            if (!h) return;
            if (Array.isArray(h)) for (const p of h) headers.push([p[0], p[1]]);
            else if (typeof h.forEach === 'function') h.forEach((v, k) => headers.push([k, v]));
            else for (const k of Object.keys(h)) headers.push([k, h[k]]);
          };
          if (req) add(req.headers);
          if (init && init.headers) add(init.headers);
          window.__scrape_net.record('fetch', (init && init.method) || (req && req.method), req ? req.url : String(input), headers);
        } catch (e) { /* never break the page's own request */ }
        return origFetch.apply(this, arguments);
      };
    }
    if (typeof XMLHttpRequest !== 'undefined') {
      const P = XMLHttpRequest.prototype;
      const origOpen = P.open;
      const origSet = P.setRequestHeader;
      const origSend = P.send;
      P.open = function __scrape_open(method, url) {
        try { this.__scrape_req = { method, url: String(url), headers: [] }; } catch (e) { /* ignore */ }
        return origOpen.apply(this, arguments);
      };
      P.setRequestHeader = function __scrape_set(name, value) {
        try { if (this.__scrape_req) this.__scrape_req.headers.push([name, value]); } catch (e) { /* ignore */ }
        return origSet.apply(this, arguments);
      };
      P.send = function __scrape_send() {
        try { const r = this.__scrape_req; if (r) { delete this.__scrape_req; window.__scrape_net.record('xhr', r.method, r.url, r.headers); } } catch (e) { /* ignore */ }
        return origSend.apply(this, arguments);
      };
    }
  }
  // opts.match: regex source tested against the request URL ("/api/search"). opts.frames: stack depth to return
  // (default 3; raise it when the top frames are all a library such as jquery/axios). Returns no header values, ever.
  S.requestOrigins = (opts = {}) => {
    let re = null;
    if (opts.match) { try { re = new RegExp(opts.match); } catch (e) { return { error: 'bad regex: ' + e.message }; } }
    const groups = new Map();
    for (const r of net.log) {
      if (re && !re.test(r.url)) continue;
      const key = r.method + ' ' + r.url.replace(/(\d{6,}|[0-9a-f-]{16,})/g, '{id}').replace(/\?.*$/, '');
      const g = groups.get(key) || { method: r.method, url: cut(key.slice(r.method.length + 1), 160), via: r.via, count: 0, headers: new Map(), plain: new Set(), frames: [] };
      g.count++;
      g.frames = r.frames; // the latest call's stack
      for (const h of r.headers) {
        if (h.plain) { g.plain.add(h.name); continue; }
        const e = g.headers.get(h.name) || { name: h.name, origin: h.origin, area: h.area, hashes: new Set() };
        if (e.origin === 'computed' && h.origin !== 'computed') { e.origin = h.origin; e.area = h.area; }
        e.hashes.add(h.hash);
        g.headers.set(h.name, e);
      }
      groups.set(key, g);
    }
    const requests = [...groups.values()].slice(-(opts.limit || 15)).map((g) => ({
      method: g.method,
      url: g.url,
      via: g.via,
      count: g.count,
      // varies: true = a different value on every call (signature, timestamp, nonce); false = same value each time; null = seen once
      headers: [...g.headers.values()].map((e) => ({ name: e.name, origin: e.origin, area: e.area, varies: g.count > 1 ? e.hashes.size > 1 : null })),
      plain_headers: [...g.plain],
      frames: g.frames.slice(0, opts.frames || 3),
    }));
    return {
      installed: !net.wrapped ? 'off' : net.late ? 'late' : 'init',
      note: !net.wrapped ? 'the fetch/XHR hook is not installed in this page' : net.late ? 'installed after the page had started: earlier requests are missing. Reload (the init script then catches the first request) or trigger the call again.' : undefined,
      seen: net.log.length,
      requests,
    };
  };

  // ---------- source map hints ----------
  // The page's script URLs and where each one's source map would sit by convention (<script url>.map).
  // Nothing is requested here: whether a map is really published is for the caller to check.
  S.sourceMapHints = (opts = {}) => {
    const seen = new Set();
    const scripts = [];
    for (const el of qsa('script[src], link[rel="modulepreload"][href]')) {
      let u;
      try { u = new URL(el.getAttribute('src') || el.getAttribute('href'), location.href); } catch (e) { continue; }
      if (!/^https?:$/.test(u.protocol) || NOISE.test(u.href)) continue;
      const bare = u.origin + u.pathname;
      if (seen.has(bare)) continue;
      seen.add(bare);
      scripts.push({ src: cut(u.href, 200), map_guess: cut(bare + '.map', 200), same_origin: u.origin === location.origin });
    }
    scripts.sort((a, b) => Number(b.same_origin) - Number(a.same_origin)); // the site's own bundles first, CDNs after
    return {
      total: scripts.length,
      scripts: scripts.slice(0, opts.limit || 30),
      inline_scripts: qsa('script:not([src])').length,
      note: 'map_guess is the conventional location only (the real one is the "//# sourceMappingURL=" comment at the end of the script, or its SourceMap response header). Nothing was requested.',
    };
  };

  // ---------- API candidates from the page's own code ----------
  // Most production sites publish no source map, so read the JavaScript the page already loaded and pull out
  // strings that look like endpoints ("/api/v2/products", "https://api.site.com/search", GraphQL operation
  // names). Only scripts from this site (same origin, or a sibling host such as static.site.com) that the page
  // itself loaded are read, from the browser cache where possible, capped by count and size; no chunk the page
  // did not load is fetched and no endpoint is called. Every result is a candidate to confirm with probe-http.
  const API_PATH = /\/(?:api|apis|rest|graphql|gql|v\d{1,2}|service|services|ajax|rpc|gateway|backend|search|query|feed|bff)(?:\/|\b)/i;
  const ASSET_PATH = /\.(?:js|mjs|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map|mp4|webp|html?)(?:[?#]|$)/i;
  const siteOf = (host) => host.split('.').slice(-2).join('.');
  S.apiCandidates = async (opts = {}) => {
    const maxScripts = opts.max_scripts || 20;
    const maxBytes = opts.max_bytes || 3_000_000;
    const site = siteOf(location.hostname);
    const urls = [];
    const add = (raw) => {
      let u;
      try { u = new URL(raw, location.href); } catch (e) { return; }
      if (!/^https?:$/.test(u.protocol) || siteOf(u.hostname) !== site || NOISE.test(u.href)) return;
      if (!urls.includes(u.href)) urls.push(u.href);
    };
    for (const el of qsa('script[src], link[rel="modulepreload"][href]')) add(el.getAttribute('src') || el.getAttribute('href'));
    try { for (const r of performance.getEntriesByType('resource')) if (r.initiatorType === 'script' || /\.m?js(\?|$)/.test(r.name)) add(r.name); } catch (e) { /* no resource timing */ }
    const found = new Map(); // endpoint -> { hits, scripts:Set, fetch_call }
    const ops = new Map();
    const scan = (text, label) => {
      const note = (raw, ctx) => {
        let ep = raw.replace(/\$\{[^}]*\}/g, '{var}').replace(/\s+/g, '');
        if (ep.length < 4 || ep.length > 160 || ASSET_PATH.test(ep) || !API_PATH.test(ep)) return;
        try { const u = new URL(ep, location.href); if (siteOf(u.hostname) !== site && /^https?:/.test(ep)) ep = u.href; } catch (e) { return; }
        const f = found.get(ep) || { hits: 0, scripts: new Set(), fetch_call: false };
        f.hits++;
        f.scripts.add(label);
        if (/fetch\(|axios|\$\.(ajax|get|post)|\.(get|post|put|request)\(|XMLHttpRequest|\.open\(/.test(ctx)) f.fetch_call = true;
        found.set(ep, f);
      };
      const re = /["'`]((?:https?:\/\/[\w.-]+)?\/[\w\-./{}$:@%~?=&,]*)["'`]/g;
      let m;
      while ((m = re.exec(text))) note(m[1], text.slice(Math.max(0, m.index - 60), m.index));
      const gq = /\b(query|mutation|subscription)\s+([A-Z][A-Za-z0-9_]{2,60})\s*[({]/g;
      while ((m = gq.exec(text))) ops.set(m[2], m[1]);
    };
    const scanned = [];
    let total = 0;
    for (const s of qsa('script:not([src])')) { const t = s.textContent || ''; if (!t.includes('window.__scrape')) scan(t, 'inline'); }
    // htmx / data-attribute driven pages keep the endpoint in the markup, not in a script ("hx-get", "data-url")
    for (const el of qsa('[hx-get],[hx-post],[data-url],[data-api],[data-endpoint],[data-href],form[action]')) {
      for (const a of ['hx-get', 'hx-post', 'data-url', 'data-api', 'data-endpoint', 'data-href', 'action']) {
        const v = el.getAttribute(a);
        if (v) scan(JSON.stringify(v), 'attribute ' + a);
      }
    }
    for (const u of urls.slice(0, maxScripts)) {
      if (total >= maxBytes) break;
      try {
        const r = await fetch(u, { credentials: 'same-origin', cache: 'force-cache' });
        if (!r.ok) { scanned.push({ src: cut(u, 160), status: r.status }); continue; }
        const text = (await r.text()).slice(0, maxBytes - total);
        total += text.length;
        scan(text, u.replace(/[?#].*$/, '').split('/').pop() || u);
        scanned.push({ src: cut(u, 160), bytes: text.length });
      } catch (e) { scanned.push({ src: cut(u, 160), error: 'not readable (CORS or network)' }); }
    }
    const endpoints = [...found.entries()]
      .map(([path, f]) => ({ path, hits: f.hits, fetch_call: f.fetch_call || undefined, scripts: [...f.scripts].slice(0, 3) }))
      .sort((a, b) => (b.fetch_call ? 1 : 0) - (a.fetch_call ? 1 : 0) || b.hits - a.hits)
      .slice(0, opts.limit || 40);
    return {
      scanned,
      skipped_scripts: Math.max(0, urls.length - maxScripts),
      endpoints,
      graphql_operations: [...ops.entries()].slice(0, 30).map(([name, kind]) => ({ name, kind })),
      note: 'Strings found in the site\'s own JavaScript, not observed requests: confirm each with probe-http.mjs (or watch it in the network panel) before using it. Paths built at runtime from several pieces are missed.',
    };
  };

  S.diagnose = () => {
    const title = norm(document.title);
    const fullText = norm(document.body ? document.body.innerText : '');
    const body = fullText.slice(0, 600);
    const thin = fullText.length < 1500; // a page whose whole content is a wall/challenge, vs. a full page that merely contains a widget
    const has = (sel) => !!document.querySelector(sel);
    const d = { blocked: false, vendor: null, kind: null, signals: [], title, body_sample: cut(body, 200) };
    const add = (vendor, kind, sig) => {
      d.blocked = true;
      d.vendor = d.vendor || vendor;
      d.kind = d.kind || kind;
      d.signals.push(sig);
    };
    // Cloudflare localizes the interstitial: Korean pages say "잠시만 기다리십시오…" / "보안 확인 수행 중" and still print a Ray ID.
    if (/just a moment|attention required|checking your browser|verify you are human|사람인지 확인|잠시만 기다리십시오|보안 확인 수행 중|보안 확인을 수행|performing a security check/i.test(title + ' ' + body)) add('cloudflare', 'js_challenge', 'cloudflare challenge text');
    if (/\bray id\b\s*[:：]/i.test(body) && /cloudflare/i.test(body)) add('cloudflare', 'js_challenge', 'cloudflare ray id');
    if (has('#challenge-form, #challenge-running, #cf-challenge-running, .cf-browser-verification')) add('cloudflare', 'js_challenge', 'cloudflare challenge dom');
    if (has('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, [data-sitekey][class*="turnstile"]')) add('cloudflare', 'turnstile', 'turnstile widget');
    if (/error code:?\s*10\d\d|access denied.*cloudflare|cloudflare ray id/i.test(body)) add('cloudflare', 'access_denied', 'cloudflare error page');
    // A reCAPTCHA/hCaptcha widget on an otherwise full page (op.gg ships a hidden one for its login form) is not a
    // block. Only a thin page whose main content IS the captcha counts; otherwise just note that the widget exists.
    if (has('iframe[src*="recaptcha"], .g-recaptcha, #recaptcha')) { if (thin) add(d.vendor || 'google', 'captcha', 'recaptcha widget'); else d.captcha_widget_present = true; }
    if (has('iframe[src*="hcaptcha"], .h-captcha')) { if (thin) add(d.vendor || 'hcaptcha', 'captcha', 'hcaptcha widget'); else d.captcha_widget_present = true; }
    if (has('script[src*="datadome"], iframe[src*="captcha-delivery.com"], iframe[src*="geo.captcha-delivery"]')) add('datadome', has('iframe[src*="captcha-delivery"]') ? 'captcha' : 'js_challenge', 'datadome');
    if (has('script[src*="px-cloud"], script[src*="perimeterx"], #px-captcha, iframe[src*="px-cdn"]') || /press & hold|press and hold/i.test(body)) add('human', has('#px-captcha') ? 'captcha' : 'js_challenge', 'perimeterx/human');
    if (/_incapsula_resource|incapsula incident id|powered by incapsula/i.test(document.documentElement.innerHTML.slice(0, 20000) + body)) add('imperva', 'js_challenge', 'incapsula');
    if (/reference\s*#\s*[\da-f.]{10,}|akamai/i.test(body) && /access denied|denied/i.test(body)) add('akamai', 'access_denied', 'akamai denied page');
    if (/access denied|403 forbidden|forbidden|차단되었습니다|접근이 거부/i.test(title + ' ' + body) && body.length < 400) add(d.vendor || 'unknown', 'access_denied', 'short denied page');
    // A bare "429" is not enough: a short list page with "Item 429" or a price of 1,429 is not a rate limit.
    // The number only counts next to error/status wording ("Error 429", "HTTP 429", "429 Too Many Requests").
    if (/too many requests|rate limit|\b(?:error|http|status|code)[\s:#]*429\b|잠시 후 다시|요청이 너무 많/i.test(title + ' ' + body) && body.length < 600) add(d.vendor || 'unknown', 'rate_limited', 'rate limit text');
    if (/pardon our interruption|unusual traffic|automated access|bot detected|robot/i.test(body) && body.length < 800) add(d.vendor || 'unknown', 'bot_page', 'bot interstitial text');
    // `body` is only the first 600 chars, so the old `body.length < 1500` was always true and any page with a
    // password field counted as a login wall. Use the full text length, as the comment always intended.
    d.login_wall = has('input[type="password"]') && (thin || /sign in|log in|login|로그인/i.test(title));
    // A wall can also be a thin page with only a "please log in" message and a button, no password field
    // (Shopee redirects visitors to /verify/traffic/error: "看起來您尚未登入。請登入以繼續"). The title often
    // stays the site's normal title, so read the text, and the URL path as a second hint.
    if (!d.login_wall && thin) {
      const loginAsk = /(?:please |to continue,? )?(?:log|sign) ?in to (?:continue|view|see)|you(?:'re| are) not (?:logged|signed) in|log ?in required|로그인이 필요|로그인 후 (?:이용|확인|계속)|로그인해 ?주세요|請登入|請先登入|尚未登入|请登录|请先登录|尚未登录|ログインしてください|ログインが必要/i;
      const loginPath = /\/(?:login|log-in|signin|sign-in|ap\/signin|auth|verify)(?:\/|$|\?)/i.test(location.pathname + '/');
      if (loginAsk.test(title + ' ' + fullText)) { d.login_wall = true; d.signals.push('login prompt text'); }
      else if (loginPath && /\b(?:log ?in|sign ?in)\b|로그인|登入|登录|ログイン/i.test(fullText)) { d.login_wall = true; d.signals.push('login path + login button'); }
    }
    d.paywall_hint = has('[class*="paywall"], [id*="paywall"], [class*="subscribe-wall"], [class*="premium-overlay"]') || /subscribe to continue|구독하고 계속|유료 회원|로그인 후 이용|구독자 전용/i.test(body);
    d.age_or_consent_gate = has('[class*="cookie"] button, #onetrust-banner-sdk, .cc-banner, [id*="consent"] button');
    d.text_length = (document.body ? document.body.innerText : '').length;
    return d;
  };
  // robots.txt check from the page's own origin (same-origin fetch works even when cross-origin would not).
  S.robots = async (pathname) => {
    const p = pathname || location.pathname + location.search;
    try {
      const r = await fetch(location.origin + '/robots.txt', { credentials: 'omit', cache: 'force-cache' });
      if (!r.ok) return { fetched: false, status: r.status, disallowed: false };
      const txt = await r.text();
      const groups = [];
      let cur = null;
      for (const raw of txt.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, '').trim();
        if (!line) continue;
        const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const k = m[1].toLowerCase();
        const v = m[2].trim();
        if (k === 'user-agent') {
          if (!cur || cur.rules.length || cur.delay) groups.push((cur = { agents: [], rules: [], delay: null }));
          cur.agents.push(v.toLowerCase());
        } else if (cur && (k === 'disallow' || k === 'allow')) cur.rules.push({ allow: k === 'allow', path: v });
        else if (cur && k === 'crawl-delay') cur.delay = v;
      }
      const star = groups.filter((g) => g.agents.includes('*'));
      const rules = star.flatMap((g) => g.rules).filter((r2) => r2.path);
      const toRe = (s) => new RegExp('^' + s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
      let best = null;
      for (const r2 of rules) if (toRe(r2.path).test(p) && (!best || r2.path.length > best.path.length)) best = r2;
      return { fetched: true, path: p, disallowed: !!best && !best.allow, matched_rule: best, crawl_delay: star.map((g) => g.delay).find(Boolean) || null, sitemaps: (txt.match(/^sitemap:\s*(\S+)/gim) || []).map((l) => l.replace(/^sitemap:\s*/i, '').trim()).slice(0, 5), total_disallow_rules: rules.filter((r2) => !r2.allow).length };
    } catch (e) {
      return { fetched: false, error: String(e), disallowed: false };
    }
  };

  // Official data sources the user should know about before we scrape: API docs, developer portals, RSS, sitemaps.
  // Word-boundary matching keeps "Sapiens" from counting as "API".
  S.officialSources = (opts = {}) => {
    const RE = /\b(api|apis|developers?|open-?api|open-?data|rss|atom|feed|sitemap|data ?download|export)\b|오픈 ?api|개발자( 센터| 포털)?|데이터 ?제공|데이터 ?다운로드|공공 ?데이터/i;
    const out = [];
    const seen = new Set();
    for (const l of qsa('link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"], link[rel="alternate"][type*="json"]')) {
      out.push({ kind: 'feed', text: l.getAttribute('title') || l.getAttribute('type'), href: l.href });
    }
    for (const a of qsa('a[href]')) {
      const text = norm(a.textContent);
      const href = a.getAttribute('href') || '';
      const hrefLooksOfficial = /\/(api|apis|developers?|dev|open-?api|rss|feed|sitemap)(\.|\/|$)/i.test(href);
      if (!(RE.test(text) || hrefLooksOfficial)) continue;
      // Headlines ("Decisions API is in public beta") and domain labels ("developers.example.com") mention the words
      // without being a site facility; only short label-like texts count unless the URL path itself looks official.
      if ((text.length > 25 || /\.[a-z]{2,}$/i.test(text)) && !hrefLooksOfficial) continue;
      let abs;
      let u;
      try {
        u = new URL(href, location.href);
        abs = u.href;
      } catch (e) {
        continue;
      }
      // A headline that links to some other site's API docs is content, not this site's facility.
      if (u.origin !== location.origin && text.length > 25) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push({ kind: /rss|atom|feed/i.test(text + href) ? 'feed' : 'api_or_docs', text: cut(text, 60), href: cut(abs, 160), where: a.closest('footer, [class*="footer"], [id*="footer"]') ? 'footer' : a.closest('nav, header') ? 'nav' : 'body' });
      if (out.length >= (opts.limit || 8)) break;
    }
    return out;
  };

  // ---------- highlight for the "is this the right data?" screenshot ----------
  const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#db2777', '#65a30d'];
  S.clearHighlight = () => {
    const o = document.getElementById('__scrape_overlay');
    if (o) o.remove();
    return true;
  };
  // fields: { name: 'css relative to container' }, opts: { container, limit=5, scroll=true }
  S.highlight = (fields, opts = {}) => {
    S.clearHighlight();
    const limit = opts.limit || 5;
    const scopes = opts.container ? qsa(opts.container).slice(0, limit) : [document];
    if (opts.scroll !== false && scopes[0] && scopes[0] !== document) {
      scopes[0].scrollIntoView({ block: 'start' });
      window.scrollBy(0, -(opts.header_offset != null ? opts.header_offset : 120)); // sticky headers cover the first item otherwise
    }
    const overlay = document.createElement('div');
    overlay.id = '__scrape_overlay';
    overlay.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;font:bold 11px/1.2 -apple-system,Segoe UI,sans-serif;';
    document.body.appendChild(overlay);
    const sx = scrollX;
    const sy = scrollY;
    const box = (el, color, label, dashed) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const b = document.createElement('div');
      b.style.cssText = `position:absolute;left:${r.left + sx - 2}px;top:${r.top + sy - 2}px;width:${r.width + 2}px;height:${r.height + 2}px;border:2px ${dashed ? 'dashed' : 'solid'} ${color};box-sizing:content-box;`;
      if (label) {
        const l = document.createElement('span');
        l.textContent = label;
        l.style.cssText = `position:absolute;left:-2px;top:-16px;background:${color};color:#fff;padding:1px 4px;border-radius:2px;white-space:nowrap;`;
        b.appendChild(l);
        b._label = l;
      }
      overlay.appendChild(b);
      return b;
    };
    const counts = {};
    const names = Object.keys(fields || {});
    scopes.forEach((sc, i) => {
      if (sc !== document) box(sc, '#64748b', i === 0 ? (opts.container_label || 'item') : '', true);
      const labelled = new Map(); // element → its label span, so two fields on one element read "제목·링크" instead of overlapping
      names.forEach((name, j) => {
        const raw = fields[name];
        const sel = typeof raw === 'string' ? raw : raw.selector;
        const matched = !sel || sel === ':scope' ? (sc === document ? [] : [sc]) : resolve(sel, sc);
        const targets = raw && typeof raw === 'object' && (raw.all || raw.transform === 'count') ? matched : matched.slice(0, 1); // all:true / count → box every match, label the first
        let hit = false;
        targets.forEach((el, k) => {
          const label = i === 0 && k === 0 ? name : '';
          const prev = label ? labelled.get(el) : null;
          const b = box(el, COLORS[j % COLORS.length], prev ? '' : label);
          if (!b) return;
          hit = true;
          if (prev) prev.textContent += '·' + name;
          else if (b._label) labelled.set(el, b._label);
        });
        counts[name] = (counts[name] || 0) + (hit ? 1 : 0);
      });
    });
    return { containers: scopes.length, fields: counts, note: 'take a screenshot now, then call clearHighlight()' };
  };

  // ---------- interaction helpers ----------
  S.autoScroll = async (opts = {}) => {
    const rounds = opts.rounds || 5;
    const wait = opts.wait_ms || 900;
    const se = document.scrollingElement || document.documentElement;
    const before = se.scrollHeight;
    const counts = [];
    for (let i = 0; i < rounds; i++) {
      window.scrollTo(0, se.scrollHeight);
      await new Promise((r) => setTimeout(r, wait));
      counts.push(se.scrollHeight);
      if (i > 0 && counts[i] === counts[i - 1]) break;
    }
    return { height_before: before, height_after: se.scrollHeight, grew: se.scrollHeight > before, rounds_run: counts.length, item_count: opts.container ? qsa(opts.container).length : undefined };
  };

  // ---------- real-browser collection (protected-site fallback) ----------
  // When the collector's own browser is hard-blocked (e.g. Akamai 403 past page 1) but the user's real
  // browser loads the pages fine, collection is driven page-by-page through that real browser instead.
  // Each navigation wipes `window`, so rows accumulate in localStorage (same-origin) and are drained at
  // the end. Same `fields`/`container` as extract() and the recipe, so nothing else about mapping changes.
  S.collectKey = '__scrape_collect';
  S.collectInto = (fields, container, opts = {}) => {
    const key = opts.key || S.collectKey;
    const dedupe = opts.dedupe_key;
    let store;
    try { store = opts.reset ? [] : JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { store = []; }
    const seen = new Set(dedupe ? store.map((r) => r[dedupe]).filter((v) => v != null) : []);
    const rows = S.extract(fields, container);
    let added = 0;
    for (const r of rows) {
      if (dedupe) { const k = r[dedupe]; if (k != null && seen.has(k)) continue; if (k != null) seen.add(k); }
      store.push(r);
      added++;
    }
    try { localStorage.setItem(key, JSON.stringify(store)); } catch (e) { return { error: 'localStorage unavailable (private window / full)', page_items: rows.length, added: 0 }; }
    const firstField = Object.keys(fields || {})[0];
    return { page_items: rows.length, added, total: store.length, sample: rows.slice(0, 2).map((r) => r[firstField]) };
  };
  // Return everything collected so far and clear it (keep: true to leave it in place).
  S.drain = (opts = {}) => {
    const key = opts.key || S.collectKey;
    let rows = [];
    try { rows = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { /* ignore */ }
    if (opts.keep !== true) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }
    return rows;
  };
  S.collectStatus = (opts = {}) => {
    try { return { total: JSON.parse(localStorage.getItem(opts.key || S.collectKey) || '[]').length }; } catch (e) { return { total: 0 }; }
  };

  // ---------- one-call overview ----------
  S.overview = (opts = {}) => {
    let shadow = 0;
    shadow = shadowRootsUnder(document).length; // nested ones too: lists inside them are found (see Shadow DOM)
    return {
      url: location.href,
      title: norm(document.title),
      lang: document.documentElement.lang || null,
      text_length: (document.body ? document.body.innerText : '').length,
      links: qsa('a[href]').length,
      images: qsa('img').length,
      tables: qsa('table').length,
      forms: qsa('form').length,
      iframes: qsa('iframe').slice(0, 5).map((f) => cut(f.getAttribute('src') || '', 100)),
      shadow_roots: shadow,
      diagnosis: S.diagnose(),
      lists: S.detectLists({ min: opts.min_items || 3, limit: 3 }).map((l) => ({ container: l.container, count: l.count, sample: l.sample, fields: l.fields.slice(0, 6).map((f) => ({ selector: f.selector, samples: f.samples.slice(0, 2) })) })),
      embedded: S.embedded(),
      pagination: S.pagination(),
      api_hints: S.apiHints({ limit: 12 }),
      official_sources: S.officialSources({ limit: 6 }),
    };
  };

  S.help = () => ({
    overview: 'overview() -> page summary: diagnosis, candidate lists, embedded JSON, pagination, API calls',
    findByText: 'findByText("39,000원") -> where that value lives + list/recipe hints',
    detectLists: 'detectLists({min:3, limit:5}) -> repeating structures with field candidates',
    probe: 'probe(selector, {within}) -> count/samples for a selector',
    extract: 'extract(fields, container) -> rows (same engine as collect.mjs)',
    highlight: 'highlight(fields, {container, limit:5}) then screenshot; clearHighlight()',
    embedded: 'embedded() / embeddedGet(source, path) -> JSON the page already ships',
    pagination: 'pagination() -> next links, page params, infinite scroll guess',
    apiHints: 'apiHints() -> XHR/fetch URLs seen so far (also see browser_network_requests)',
    apiCandidates: 'await apiCandidates() -> endpoint-looking strings and GraphQL operation names from the JavaScript this page already loaded (same site only; candidates for probe-http)',
    sourceMapHints: 'sourceMapHints() -> this page\'s script URLs and the conventional .map URL for each (no network requests)',
    requestOrigins: 'requestOrigins({match, frames}) -> per API call: header names, where each value comes from (storage:<key> / cookie:<name> / computed), and the script frames that sent it. Never returns header values',
    officialSources: 'officialSources() -> links to API docs, developer portals, RSS/sitemaps on this page',
    diagnose: 'diagnose() -> bot-block / login / paywall signals',
    robots: 'await robots(path) -> robots.txt verdict for this origin',
    autoScroll: 'await autoScroll({rounds, container}) -> infinite scroll test',
    collectInto: 'collectInto(fields, container, {dedupe_key, reset}) -> extract this page and accumulate in localStorage (real-browser fallback for blocked sites)',
    drain: 'drain() -> return everything collectInto() gathered and clear it; pass to write-csv.mjs',
    collectStatus: 'collectStatus() -> { total }: how many rows accumulated so far',
  });

  window.__scrape = S;
  return 'installed';
})();
