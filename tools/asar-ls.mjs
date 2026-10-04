#!/usr/bin/env node
/**
 * List or read files inside an Electron `app.asar` archive.
 *
 * Useful because a packaged DeepSeek Harness keeps its whole runtime — every
 * `@deepseek-ai/dsh-*` package, the profile loader, the plugin manager — inside
 * `app.asar`, which ordinary Node cannot read. Only Electron's fs understands the
 * archive, so run this under Electron-as-Node:
 *
 *   Windows:
 *     $env:ELECTRON_RUN_AS_NODE="1"
 *     & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" `
 *         tools/asar-ls.mjs dsh/node_modules/@deepseek-ai
 *
 *   macOS:
 *     ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *         tools/asar-ls.mjs dsh/node_modules/@deepseek-ai
 *
 * A directory prints its entries ("d name" / "- name"); a file prints its UTF-8
 * contents, so you can pipe it straight to a file.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function defaultAsar() {
  const candidates = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]) {
      if (base) candidates.push(join(base, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'), join(base, 'DeepSeek Harness', 'resources', 'app.asar'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar', join(homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'app.asar'));
  } else {
    candidates.push('/opt/DeepSeek Harness/resources/app.asar', '/usr/lib/deepseek-harness/resources/app.asar', join(homedir(), '.local/share/deepseek-harness/resources/app.asar'));
  }
  if (process.env.DSH_ASAR) candidates.unshift(process.env.DSH_ASAR);
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new Error(`cannot find app.asar. Tried:\n  ${candidates.join('\n  ')}\nPass the archive path as the first argument or set DSH_ASAR.`);
}

const argv = process.argv.slice(2);
const help = argv.includes('--help') || argv.includes('-h');

if (help || argv.length === 0) {
  console.log(`Usage: <electron-as-node> asar-ls.mjs [<asar>] <path-inside-archive>

  <asar>                    archive path (default: auto-detect, or $DSH_ASAR)
  <path-inside-archive>     e.g. dsh/node_modules/@deepseek-ai

Examples:
  asar-ls.mjs dsh/node_modules/@deepseek-ai
  asar-ls.mjs dsh/node_modules/@deepseek-ai/dsh-plugin-manager/README.md > pm.md
`);
  process.exit(help ? 0 : 1);
}

// First argument is the archive only when a second argument exists and it looks
// like an .asar path; otherwise the single argument is the path inside.
let asar;
let inner;
if (argv.length >= 2) {
  asar = argv[0];
  inner = argv[1];
} else {
  asar = defaultAsar();
  inner = argv[0];
}

const full = join(asar, inner.replace(/^[/\\]+/, ''));

if (!existsSync(full)) {
  console.error(`not found in archive: ${inner}`);
  process.exit(2);
}

if (statSync(full).isDirectory()) {
  for (const e of readdirSync(full, { withFileTypes: true })) {
    console.log(`${e.isDirectory() ? 'd' : '-'} ${e.name}`);
  }
} else {
  process.stdout.write(readFileSync(full, 'utf8'));
}
