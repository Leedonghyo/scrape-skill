#!/usr/bin/env node
/*
 * probe-http.mjs — does this URL work without a browser?
 * Prints ONE JSON object describing the response so the model can pick http / embedded / dom.
 * Exit 0 when the request completed (whatever the status), 1 on usage or network failure.
 */
import {
  parseArgs, defaultHeaders, mergeHeaders, loadStorageState, cookieHeader, detectBlockedHttp,
  shape, scripts, windowAssignmentNames, tryParse, UsageError,
} from './lib.mjs';

const USAGE = `usage: node probe-http.mjs <url> [--headers '{"k":"v"}'] [--cookies storageState.json] [--method GET] [--body '...']`;
const ARGS = { headers: 'string', cookies: 'string', method: 'string', body: 'string', help: 'boolean' };

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2), ARGS); } catch (e) { console.error(`${e.message}\n${USAGE}`); return 1; }
  if (opts.help || !opts._[0]) { console.error(USAGE); return opts.help ? 0 : 1; }
  let url = opts._[0];
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let extra = {};
  if (opts.headers) {
    extra = tryParse(opts.headers);
    if (!extra || typeof extra !== 'object') { console.error('--headers must be a JSON object'); return 1; }
  }
  let session = null;
  try { session = loadStorageState(opts.cookies); } catch (e) { console.error(e.message); return 1; }
  // Same defaults as collect.mjs, but accept both JSON and HTML because we do not know yet which one this is.
  const headers = mergeHeaders(defaultHeaders('any'), extra);
  const cookie = session ? cookieHeader(session.cookies, url) : null;
  if (cookie && !headers.cookie) headers.cookie = cookie;
  const method = (opts.method || 'GET').toUpperCase();
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { method, headers, body: opts.body ?? undefined, redirect: 'follow', signal: AbortSignal.timeout(45_000) });
  } catch (e) {
    console.log(JSON.stringify({ url, error: e.cause?.message || e.message, elapsed_ms: Date.now() - t0 }));
    return 1;
  }
  const text = await res.text();
  const elapsed_ms = Date.now() - t0;
  const content_type = res.headers.get('content-type') || null;
  const json = tryParse(text);
  const is_json = json !== undefined && (typeof json === 'object' || /json/i.test(content_type || ''));
  const html = /^\s*(<!doctype|<html|<head|<body|<script|<div)/i.test(text) || /html/i.test(content_type || '');
  const out = {
    url,
    status: res.status,
    content_type,
    bytes: Buffer.byteLength(text),
    elapsed_ms,
    is_json,
    json_shape: is_json ? shape(json, 2) : null,
    html_title: html ? ((text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim() || null : null,
    blocked: detectBlockedHttp(res.status, res.headers, text),
    embedded: html
      ? {
          next_data: scripts(text).some((s) => /id=["']?__NEXT_DATA__["']?/i.test(s.attrs)),
          ldjson_count: scripts(text).filter((s) => /type=["']?application\/ld\+json["']?/i.test(s.attrs)).length,
          window_assignments: windowAssignmentNames(text, 20),
        }
      : { next_data: false, ldjson_count: 0, window_assignments: [] },
    redirected_to: res.url && res.url !== url ? res.url : null,
  };
  if (!is_json && !html) out.text_sample = text.slice(0, 200);
  console.log(JSON.stringify(out));
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e instanceof UsageError ? e.message : e.stack || e); process.exit(1); });
