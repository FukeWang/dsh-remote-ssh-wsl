#!/usr/bin/env node
/**
 * Offline replica of a DeepSeek Harness profile composition.
 *
 * Why this exists: DSH is fail-loud about plugin rows. If a bundle listed in
 * `dsh.profile.bundles` is missing, declares no `dsh.bundle` patch, or ships an
 * unparsable patch file, the *whole profile* refuses to start — the GUI does not
 * come up at all. This script replays exactly the same composition the host does
 * (`loadProfileDirectory` + `composeEntries`, from the same `dsh-app-boot` the
 * app itself uses, against the same install anchor) WITHOUT booting a server, so
 * you can prove a plugin install is boot-safe before restarting anything.
 *
 * It must run under Electron-as-Node, because the Desktop runtime lives inside
 * `app.asar` and only Electron's fs can read that archive:
 *
 *   Windows:
 *     $env:ELECTRON_RUN_AS_NODE="1"
 *     & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" `
 *         tools/compose-profile.mjs --profile desktop
 *
 *   macOS:
 *     ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *         tools/compose-profile.mjs --profile desktop
 *
 * Exits: 0 = composed cleanly, 2 = bundle/profile load failed, 3 = compose failed.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── arguments ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { profile: process.env.DSH_PROFILE ?? 'desktop', json: false, grep: undefined, resources: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--grep') out.grep = (argv[++i] ?? '').toLowerCase();
    else if (a === '--resources') out.resources = argv[++i];
    else if (a === '--profile') out.profile = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Usage: <electron-as-node> compose-profile.mjs [options]

  --profile <name>     profile under $DSH_HOME/profiles (default: $DSH_PROFILE or "desktop")
  --resources <dir>    DeepSeek Harness "resources" directory (default: auto-detect)
  --grep <substr>      only print rows whose id or module name contains <substr>
  --json               print the full row list as JSON
  -h, --help           this text
`);
  process.exit(0);
}

// ── locate the installed runtime ─────────────────────────────────────────────

/** Candidate `resources` directories for the packaged Desktop app, by platform. */
function resourceCandidates() {
  const home = homedir();
  const list = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]) {
      if (base) list.push(join(base, 'Programs', 'DeepSeek Harness', 'resources'), join(base, 'DeepSeek Harness', 'resources'));
    }
  } else if (process.platform === 'darwin') {
    list.push('/Applications/DeepSeek Harness.app/Contents/Resources', join(home, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources'));
  } else {
    list.push('/opt/DeepSeek Harness/resources', '/usr/lib/deepseek-harness/resources', '/usr/share/deepseek-harness/resources', join(home, '.local/share/deepseek-harness/resources'));
  }
  if (process.env.DSH_RESOURCES) list.unshift(process.env.DSH_RESOURCES);
  return list;
}

function findResources(explicit) {
  const candidates = explicit ? [explicit] : resourceCandidates();
  for (const dir of candidates) {
    if (!dir) continue;
    // A packaged install has app.asar; a prepared/dev install has ./dsh directly.
    if (existsSync(join(dir, 'app.asar')) || existsSync(join(dir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-app-boot'))) {
      return dir;
    }
  }
  throw new Error(
    `cannot find a DeepSeek Harness resources directory. Tried:\n  ${candidates.join('\n  ')}\n` +
      'Pass --resources <dir> or set DSH_RESOURCES.',
  );
}

const resources = findResources(args.resources);

/** The dsh runtime tree: inside app.asar when packaged, beside it otherwise. */
function findRuntimeDir(res) {
  const asarRuntime = join(res, 'app.asar', 'dsh');
  if (existsSync(join(asarRuntime, 'node_modules', '@deepseek-ai', 'dsh-app-boot'))) return asarRuntime;
  const plain = join(res, 'dsh');
  if (existsSync(join(plain, 'node_modules', '@deepseek-ai', 'dsh-app-boot'))) return plain;
  throw new Error(`no dsh runtime under ${res} (looked for app.asar/dsh and dsh)`);
}

const runtimeDir = findRuntimeDir(resources);
const appBoot = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', args.profile);

if (!existsSync(profileDir)) {
  console.error(`profile directory not found: ${profileDir}`);
  process.exit(2);
}

// Import through an absolute file URL: this script lives outside the profile
// tree, so a bare specifier would not resolve. The module's own imports still
// resolve from the installation it lives in.
const { loadProfileDirectory, composeEntries } = await import(pathToFileURL(appBoot).href);

// ── compose ──────────────────────────────────────────────────────────────────

console.log(`resources      : ${resources}`);
console.log(`runtime        : ${runtimeDir}`);
console.log(`profile        : ${profileDir}`);
console.log('');

let profile;
try {
  profile = loadProfileDirectory('dsh', profileDir, installAnchor);
} catch (error) {
  console.error(`LOAD FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

console.log(`patchReload    : ${profile.patchReload ?? '(default)'}`);
console.log(`bundles        : ${profile.layers.length} (application order)`);
for (const layer of profile.layers) console.log(`  - ${layer.packageName}`);
console.log(`profile patch  : ${profile.patches.length} entr${profile.patches.length === 1 ? 'y' : 'ies'}`);
console.log('');

const warnings = [];
let entries;
try {
  entries = composeEntries([...profile.layers.map((l) => l.patches), profile.patches], (...a) => {
    warnings.push(a.join(' '));
  });
} catch (error) {
  console.error(`COMPOSE FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(3);
}

if (warnings.length > 0) {
  console.log(`compose warnings (${warnings.length}):`);
  for (const w of warnings) console.log(`  ! ${w}`);
  console.log('');
}

const rows = entries.map((e) => ({
  id: e.id ?? '(no id)',
  name: typeof e.name === 'string' ? e.name : '(no name)',
  disabled: e.disabled === true,
}));

console.log(`composed rows  : ${rows.length}`);

if (args.json) {
  console.log(JSON.stringify(rows, null, 2));
} else if (args.grep !== undefined) {
  for (const r of rows.filter((r) => r.id.toLowerCase().includes(args.grep) || r.name.toLowerCase().includes(args.grep))) {
    console.log(`  ${r.disabled ? 'DISABLED' : 'enabled '}  ${r.id}  =  ${r.name}`);
  }
} else {
  for (const r of rows) console.log(`  ${r.disabled ? 'DISABLED' : 'enabled '}  ${r.id}  =  ${r.name}`);
}

console.log('');
console.log('OK: bundle list and every patch layer composed cleanly — boot will not fail on composition.');
