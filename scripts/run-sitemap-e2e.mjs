#!/usr/bin/env node
/**
 * run-sitemap-e2e.mjs — regenerate the nav map, then run the sitemap E2E suite.
 *
 *   node scripts/run-sitemap-e2e.mjs            # headless
 *   node scripts/run-sitemap-e2e.mjs --headed   # visible browser, slowed playback
 *
 * Why a wrapper instead of putting --headed straight in the npm script: the
 * Playwright CLI reparses argv before the config module can inspect it, so a
 * config that tries `process.argv.includes('--headed')` never sees the flag.
 * Setting SITEMAP_E2E_HEADED here is unambiguous, and doing it in Node keeps it
 * cross-platform (no cross-env dependency, works in PowerShell and bash alike).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const headed = process.argv.includes('--headed');
const passthrough = process.argv.slice(2).filter((a) => a !== '--headed');

/**
 * `shell` is opt-in per call. npx needs it on Windows (it resolves to npx.cmd),
 * but node does not — and running node through a shell breaks on the default
 * install path, where process.execPath contains a space ("C:\Program Files\...")
 * and the shell splits it at "C:\Program".
 */
const run = (cmd, args, { shell = false, extraEnv = {} } = {}) =>
  spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell,
    env: { ...process.env, ...extraEnv },
  });

const map = run(process.execPath, [path.join('scripts', 'build-nav-map.mjs')]);
if (map.status !== 0) process.exit(map.status ?? 1);

const args = ['playwright', 'test', '--config', 'tests/playwright-sitemap.config.ts', ...passthrough];
if (headed) args.push('--headed');

const result = run('npx', args, {
  shell: process.platform === 'win32',
  extraEnv: headed ? { SITEMAP_E2E_HEADED: '1' } : {},
});
process.exit(result.status ?? 1);
