/**
 * Run every verification script.
 *
 *     npm run verify              node checks only
 *     npm run verify -- --all     also the browser checks (needs `npm run dev` running)
 *
 * These are plain scripts, not a test framework. Each one imports the real engine modules,
 * asserts things about them, and exits non-zero if anything is wrong. The node checks need
 * no browser: `lib/harness.ts` stubs the handful of DOM calls `Framebuffer` makes, and
 * nothing in the render path touches the DOM.
 *
 * TypeScript is bundled through rolldown, which ships with Vite, so there is no extra
 * dependency and no build step to keep in sync.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ROLLDOWN = join(ROOT, 'node_modules', '.bin', 'rolldown');

const withBrowser = process.argv.includes('--all');
const scratch = mkdtempSync(join(tmpdir(), 'ray-verify-'));

let failed = 0;

function run(label, command, args, options = {}) {
  console.log(`\n${'='.repeat(74)}\n${label}\n${'='.repeat(74)}`);
  try {
    execFileSync(command, args, { stdio: 'inherit', cwd: ROOT, ...options });
  } catch {
    failed++;
    console.log(`\n>>> ${label} FAILED`);
  }
}

for (const file of readdirSync(join(HERE, 'node')).filter((f) => f.endsWith('.ts')).sort()) {
  const bundle = join(scratch, `${file.replace(/\.ts$/, '')}.mjs`);
  execFileSync(ROLLDOWN, [join(HERE, 'node', file), '-o', bundle, '--format', 'esm', '--platform', 'node'], {
    cwd: ROOT,
    stdio: 'pipe',
  });
  run(`node/${file}`, process.execPath, [bundle]);
}

if (withBrowser) {
  for (const file of readdirSync(join(HERE, 'browser')).filter((f) => f.endsWith('.mjs')).sort()) {
    run(`browser/${file}`, process.execPath, [join(HERE, 'browser', file)]);
  }
} else {
  console.log('\n(skipping browser checks — pass --all with `npm run dev` running)');
}

rmSync(scratch, { recursive: true, force: true });

console.log(`\n${'='.repeat(74)}`);
console.log(failed === 0 ? 'ALL SUITES PASSED' : `${failed} SUITE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
