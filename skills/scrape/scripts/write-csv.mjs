#!/usr/bin/env node
/*
 * write-csv.mjs — turn a JSON array of rows into a CSV/JSON/JSONL file.
 *
 * This is the end of the real-browser fallback (see SKILL.md "Protected sites"): when a site is
 * hard-blocked for the collector's own browser but loads in the user's real browser, rows are gathered
 * page-by-page with window.__scrape.collectInto() and handed back by __scrape.drain(). Save that array
 * to a file and run this to get the same UTF-8-BOM CSV the collector would have produced.
 *
 * Usage:
 *   node write-csv.mjs <rows.json> [--out PATH] [--format csv|json|jsonl] [--name NAME] [--dedupe-key KEY] [--columns a,b,c]
 *   cat rows.json | node write-csv.mjs - [...]
 * Default output: ~/Downloads/<name|scrape>-<YYYYMMDD>.csv
 * Prints one JSON line: { ok, output, rows, columns, fill_rate }.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expandHome, FORMATS, parseArgs, writeRows, unionColumns, fillRate, UsageError } from './lib.mjs';

const USAGE = 'usage: node write-csv.mjs <rows.json | -> [--out PATH] [--format csv|json|jsonl] [--name NAME] [--dedupe-key KEY] [--columns a,b,c]';
const SPEC = { out: 'string', format: 'string', name: 'string', 'dedupe-key': 'string', columns: 'string', help: 'boolean' };

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2), SPEC); } catch (e) { console.error(e.message + '\n' + USAGE); return 1; }
  const src = opts._[0];
  if (opts.help || !src) { console.error(USAGE); return opts.help ? 0 : 1; }

  let raw;
  try { raw = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(expandHome(src), 'utf8'); }
  catch (e) { console.error(`[write-csv] cannot read ${src}: ${e.message}`); return 1; }
  let rows;
  try { rows = JSON.parse(raw); } catch (e) { console.error(`[write-csv] ${src} is not valid JSON: ${e.message}`); return 1; }
  if (!Array.isArray(rows)) { console.error('[write-csv] expected a JSON array of row objects'); return 1; }

  if (opts['dedupe-key']) {
    const k = opts['dedupe-key'];
    const seen = new Set();
    rows = rows.filter((r) => { const v = r && r[k]; if (v == null) return true; if (seen.has(v)) return false; seen.add(v); return true; });
  }

  const format = opts.format || 'csv';
  if (!FORMATS.includes(format)) { console.error(`[write-csv] --format must be one of ${FORMATS.join(', ')}`); return 1; }
  const columns = opts.columns ? opts.columns.split(',').map((s) => s.trim()).filter(Boolean) : unionColumns(rows);
  const name = opts.name || 'scrape';
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const ext = format === 'csv' ? 'csv' : format === 'jsonl' ? 'jsonl' : 'json';
  const out = path.resolve(expandHome(opts.out || `~/Downloads/${name}-${date}.${ext}`));

  try { writeRows({ file: out, format, rows, columns, append: false }); }
  catch (e) { console.error(`[write-csv] cannot write ${out}: ${e.message}`); return 1; }

  console.error(`[write-csv] wrote ${rows.length} rows → ${out}`);
  console.log(JSON.stringify({ ok: true, output: out, rows: rows.length, columns, fill_rate: fillRate(rows, columns) }));
  return 0;
}

process.exit(main());
