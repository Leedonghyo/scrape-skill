#!/usr/bin/env node
/*
 * doctor.mjs — is this machine ready to run collect.mjs?
 * Prints one line per check, then a single JSON summary line. Exit 1 when something required is missing.
 * `--fix` runs `npm install --omit=dev` in scripts/ when node_modules is missing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SCRIPTS_DIR, SCRAPE_HOME, parseArgs } from './lib.mjs';

const opts = parseArgs(process.argv.slice(2), { fix: 'boolean', help: 'boolean' });
if (opts.help) { console.log('usage: node doctor.mjs [--fix]'); process.exit(0); }

const problems = [];
const fixes = [];
const line = (ok, label, detail, required = true) => {
  console.log(`[${ok ? 'ok' : required ? 'MISSING' : 'warn'}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok && required) problems.push(label);
};
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const onPath = (names) => {
  for (const n of names) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [n], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  }
  return null;
};

// 1. Node
const major = Number(process.versions.node.split('.')[0]);
line(major >= 20, `node ${process.versions.node}`, major >= 20 ? null : 'need Node 20 or newer (built-in fetch)');

// 2. node_modules / playwright-core
const installCmd = `cd "${SCRIPTS_DIR}" && npm install --omit=dev`;
let modulesOk = exists(path.join(SCRIPTS_DIR, 'node_modules', 'playwright-core', 'package.json'));
if (!modulesOk && opts.fix) {
  console.log(`[fix] running: ${installCmd}`);
  const r = spawnSync('npm', ['install', '--omit=dev'], { cwd: SCRIPTS_DIR, stdio: 'inherit', shell: process.platform === 'win32' });
  modulesOk = r.status === 0 && exists(path.join(SCRIPTS_DIR, 'node_modules', 'playwright-core', 'package.json'));
}
line(modulesOk, 'node_modules in scripts/', modulesOk ? null : `run: ${installCmd}`);
if (!modulesOk) fixes.push(installCmd);
let pwVersion = null;
let chromium = null;
if (modulesOk) {
  try {
    pwVersion = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'node_modules', 'playwright-core', 'package.json'), 'utf8')).version;
    ({ chromium } = await import('playwright-core'));
  } catch (e) { line(false, 'playwright-core resolves', e.message.split('\n')[0]); }
  if (chromium) line(true, `playwright-core ${pwVersion} resolves`);
}

// 3. A browser: real Chrome/Edge first (persistent profile, looks like the user's own browser), bundled chromium as fallback.
const home = os.homedir();
const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const candidates = process.platform === 'darwin'
  ? { chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')], edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] }
  : process.platform === 'win32'
    ? { chrome: [path.join(pf, 'Google/Chrome/Application/chrome.exe'), path.join(pf86, 'Google/Chrome/Application/chrome.exe'), path.join(local, 'Google/Chrome/Application/chrome.exe')], edge: [path.join(pf, 'Microsoft/Edge/Application/msedge.exe'), path.join(pf86, 'Microsoft/Edge/Application/msedge.exe')] }
    : { chrome: [], edge: [] };
const chrome = candidates.chrome.find(exists) || (process.platform === 'linux' ? onPath(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) : null);
const edge = candidates.edge.find(exists) || (process.platform === 'linux' ? onPath(['microsoft-edge', 'microsoft-edge-stable']) : null);
line(!!chrome, 'Google Chrome', chrome || 'not found', false);
line(!!edge, 'Microsoft Edge', edge || 'not found', false);
let bundled = null;
if (chromium) {
  try { const p = chromium.executablePath(); if (p && exists(p)) bundled = p; } catch { /* no bundled browser registered */ }
}
line(!!bundled, 'bundled Playwright chromium', bundled || 'not installed (only needed when Chrome/Edge are absent)', false);
const browserOk = !!(chrome || edge || bundled);
const installBrowser = `cd "${SCRIPTS_DIR}" && npx playwright install chromium`;
line(browserOk, 'a usable browser', browserOk ? null : `install Google Chrome, or run: ${installBrowser}`);
if (!browserOk) fixes.push(installBrowser);

// 4. ~/.scrape working directories
const dirs = ['recipes', 'sessions', 'state', 'profile'].map((d) => path.join(SCRAPE_HOME, d));
let dirsOk = true;
for (const d of dirs) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) { dirsOk = false; line(false, `create ${d}`, e.message); } }
if (dirsOk) line(true, `${SCRAPE_HOME}/{recipes,sessions,state,profile}`);

// 5. ~/Downloads (default output location; --out can point elsewhere, so this is a warning)
const downloads = path.join(home, 'Downloads');
let downloadsOk = false;
try {
  fs.mkdirSync(downloads, { recursive: true });
  const probe = path.join(downloads, `.scrape-doctor-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  downloadsOk = true;
} catch { /* reported below */ }
line(downloadsOk, `${downloads} writable`, downloadsOk ? null : 'default output goes here; use --out to write elsewhere', false);

const ok = problems.length === 0;
console.log(ok ? 'All required checks passed.' : `Problems: ${problems.join('; ')}`);
console.log(JSON.stringify({
  ok, node: process.versions.node, platform: process.platform, scripts_dir: SCRIPTS_DIR, node_modules: modulesOk, playwright_core: pwVersion,
  browser: { chrome: chrome || null, edge: edge || null, bundled_chromium: bundled || null },
  scrape_home: dirsOk ? SCRAPE_HOME : null, downloads: downloadsOk ? downloads : null, problems, fixes,
}));
process.exit(ok ? 0 : 1);
