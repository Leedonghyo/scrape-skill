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
    const parts = [];
    const scope = root === document ? document : root;
    // Does [p, ...parts] pin exactly one element inside root? Tested as a descendant chain, which is the
    // conservative reading (if it is unique as a descendant it is unique as a child chain too).
    const unique = (p) => {
      try {
        const sel = [p, ...parts].join(' > ');
        return scope.querySelectorAll(root === document ? sel : ':scope ' + sel).length === 1;
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
    if (root !== document && !sel.startsWith(':scope')) sel = (top && top.parentElement === root ? ':scope > ' : ':scope ') + sel;
    return sel;
  };
  const cssPath = (el) => pathWithin(el, document);
  const generalize = (sel) => sel.replace(/:nth-of-type\(\d+\)/g, '');
  const qsa = (sel, scope) => {
    try {
      return [...(scope || document).querySelectorAll(sel)];
    } catch (e) {
      return [];
    }
  };

  // Find the repeating "item" ancestor of el (a product card, a table row, a list entry).
  // Picks the ancestor with the most same-signature siblings (>=3); ties go to the deeper one.
  const itemAncestor = (el, min = 3) => {
    let best = null;
    let cur = el;
    while (cur && cur.parentElement && cur !== document.body) {
      const parent = cur.parentElement;
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
  const value = (e, spec) => {
    let v;
    if (!spec.attr || spec.attr === 'text') v = norm(e.textContent);
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
  // fields: { name: 'css' | { selector, attr, all, regex, transform, absolute } }
  // container: css for each item (one row per match). Omit for a single-row page.
  S.extract = (fields, container) => {
    const scopes = container ? qsa(container) : [document];
    const rows = [];
    for (const sc of scopes) {
      const row = {};
      let any = false;
      for (const [name, raw] of Object.entries(fields || {})) {
        const spec = typeof raw === 'string' ? { selector: raw } : raw || {};
        const els = resolve(spec.selector, sc);
        if (spec.all) {
          const arr = els.map((e) => value(e, spec)).filter((v) => v != null && v !== '');
          // join: "\n\n" turns the paragraphs of an article body into one text cell instead of an array
          row[name] = spec.join != null ? arr.join(spec.join) : arr;
        } else row[name] = els.length ? value(els[0], spec) : null;
        if (row[name] != null && row[name] !== '' && !(Array.isArray(row[name]) && !row[name].length)) any = true;
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
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
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
      for (const e of qsa('[title],[alt],[value],[content],[aria-label],[href],[data-price],[data-value]')) {
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
    for (const parent of qsa('body *')) {
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
        const texts = items.map((i) => norm(i.textContent));
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
        sample: cut(norm(items[0].textContent), 160),
        fields: fieldCandidates(items),
      };
    });
  };
  // Leaf elements of item[0] whose relative selector also exists in items[1..2] with different text => data fields.
  const fieldCandidates = (items) => {
    const first = items[0];
    const probe = items.slice(1, 4);
    const leaves = qsa('*', first).filter((e) => !SKIP_TAGS.has(e.tagName) && (e.children.length === 0 || e.matches('a, img, time, button')) && (norm(e.textContent) || e.matches('img, a[href], time[datetime]')));
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
  const getPath = (obj, path) => {
    if (!path || path === '$') return obj;
    const segs = path.replace(/\[(\d+)\]/g, '.$1').replace(/\[\]/g, '.[]').split('.').filter(Boolean);
    let cur = obj;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (cur == null) return undefined;
      if (s === '[]') {
        const rest = segs.slice(i + 1).join('.');
        return Array.isArray(cur) ? cur.map((x) => getPath(x, rest)) : undefined;
      }
      cur = cur[s];
    }
    return cur;
  };
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
    if (/just a moment|attention required|checking your browser|verify you are human|사람인지 확인/i.test(title + ' ' + body)) add('cloudflare', 'js_challenge', 'cloudflare challenge text');
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
    if (/too many requests|rate limit|429|잠시 후 다시|요청이 너무 많/i.test(title + ' ' + body) && body.length < 600) add(d.vendor || 'unknown', 'rate_limited', 'rate limit text');
    if (/pardon our interruption|unusual traffic|automated access|bot detected|robot/i.test(body) && body.length < 800) add(d.vendor || 'unknown', 'bot_page', 'bot interstitial text');
    // `body` is only the first 600 chars, so the old `body.length < 1500` was always true and any page with a
    // password field counted as a login wall. Use the full text length, as the comment always intended.
    d.login_wall = has('input[type="password"]') && (thin || /sign in|log in|login|로그인/i.test(title));
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
        const targets = raw && typeof raw === 'object' && raw.all ? matched : matched.slice(0, 1); // all:true → box every match, label the first
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
    for (const e of qsa('body *').slice(0, 5000)) if (e.shadowRoot) shadow++;
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
    officialSources: 'officialSources() -> links to API docs, developer portals, RSS/sitemaps on this page',
    diagnose: 'diagnose() -> bot-block / login / paywall signals',
    robots: 'await robots(path) -> robots.txt verdict for this origin',
    autoScroll: 'await autoScroll({rounds, container}) -> infinite scroll test',
    collectInto: 'collectInto(fields, container, {dedupe_key, reset}) -> extract this page and accumulate in localStorage (real-browser fallback for blocked sites)',
    drain: 'drain() -> return everything collectInto() gathered and clear it; pass to write-csv.mjs',
    collectStatus: 'collectStatus() -> how many rows accumulated so far',
  });

  window.__scrape = S;
  return 'installed';
})();
