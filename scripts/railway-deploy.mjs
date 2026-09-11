#!/usr/bin/env node
/**
 * railway-deploy.mjs — ship unisona.ai to Railway, the guarded way (#3524).
 *
 * Production is Railway (project `unisona`, service `unisona`, environment `production`)
 * and it runs whatever `railway up` last uploaded. Done by hand from a working checkout,
 * that shipped whatever the checkout held — uncommitted edits included — at any hour (a
 * build went out at 15:11 ET on 2026-09-11, mid-session), and nothing recorded which code
 * went out: /api/version said commit "unknown", because .railwayignore keeps .git out.
 *
 * What this does instead:
 *   1. Refuses during the US regular session — Mon–Fri 09:25–16:05 ET, the bell plus
 *      5 minutes either side — unless --force. A deploy restarts the app, and the app
 *      runs the users' trader. Holidays and early closes aren't modeled; they only make
 *      it wait until 16:05.
 *   2. Checks the commit to ship (default origin/master, freshly fetched) out into a
 *      throwaway worktree, so only committed code ships. It stops if images come out as
 *      Git LFS pointer files instead of images.
 *   3. Writes build-info.json at the upload root. lib/git-version reads it where there
 *      is no .git, so /api/version names the commit production runs.
 *   4. Plans by default. --yes runs `railway up` for real, then waits for
 *      https://unisona.ai/api/version to report the commit it shipped.
 *
 *   node scripts/railway-deploy.mjs                        plan: what would ship; nothing uploaded
 *   node scripts/railway-deploy.mjs --yes                  ship origin/master
 *   node scripts/railway-deploy.mjs --ref <sha|tag> --yes  ship (or roll back to) one commit
 *   node scripts/railway-deploy.mjs --yes --force          during the session: an urgent fix only
 *
 * Needs git + git-lfs and the Railway CLI logged in to the project (`railway whoami`).
 * Variables (secrets) are not part of a deploy: `railway variable set`, then
 * `railway redeploy`. See docs/ops/railway-runbook.md.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TARGET = { project: 'unisona', service: 'unisona', environment: 'production', url: 'https://unisona.ai' };

/** True while the US regular session, with its 5-minute margins, is on. */
export function inSession(at = new Date()) {
  const p = {};
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (const x of fmt.formatToParts(at)) p[x.type] = x.value;
  const m = Number(p.hour) * 60 + Number(p.minute);
  return p.weekday !== 'Sat' && p.weekday !== 'Sun' && m >= 565 && m < 965;
}

export function parseArgs(argv) {
  const o = { yes: false, force: false, ref: 'origin/master', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--force') o.force = true;
    else if (a === '--ref') o.ref = argv[++i] || '';
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.ref) throw new Error('--ref needs a value');
  return o;
}

export function buildInfo({ commit, ref, date, subject, by, at }) {
  return { commit, ref, date, subject, deployedBy: by, deployedAt: at, via: 'scripts/railway-deploy.mjs' };
}

/** A Git LFS pointer file where an image should be: the checkout ran without git-lfs. */
export function isLfsPointer(buf) {
  return Buffer.from(buf).subarray(0, 48).toString('utf8').startsWith('version https://git-lfs.github.com/spec');
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: REPO, ...opts });
  if (r.error) throw new Error(`${cmd} ${args.join(' ')}: ${r.error.message}`);
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}: ${String(r.stderr || r.stdout || '').trim().slice(0, 400)}`);
  return String(r.stdout || '').trim();
}
// The Railway CLI is an npm shim on Windows (railway.cmd). Start it through cmd.exe /c,
// the way lib/safe-exec starts npm and npx: argv, never a free-form shell string.
const railway = (args, opts = {}) => (process.platform === 'win32'
  ? spawnSync('cmd.exe', ['/c', 'railway', ...args], { encoding: 'utf8', ...opts })
  : spawnSync('railway', args, { encoding: 'utf8', ...opts }));

function lfsPointersIn(dir) {
  const root = path.join(dir, 'apps', 'lantern-garage', 'public');
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (found.length >= 5) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(png|jpe?g|gif|pdf|zip)$/i.test(e.name)) {
        const fd = fs.openSync(p, 'r');
        const b = Buffer.alloc(64);
        fs.readSync(fd, b, 0, 64, 0);
        fs.closeSync(fd);
        if (isLfsPointer(b)) found.push(path.relative(dir, p));
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found;
}

function projectId(name) {
  if (process.env.RAILWAY_PROJECT_ID) return process.env.RAILWAY_PROJECT_ID;
  const r = railway(['list', '--json']);
  if (r.status !== 0) throw new Error('railway list failed: is the Railway CLI installed and logged in? (railway whoami)');
  const j = JSON.parse(r.stdout);
  const p = (Array.isArray(j) ? j : (j.projects || [])).find((x) => x.name === name);
  if (!p) throw new Error(`Railway project "${name}" isn't visible to this login (railway whoami)`);
  return p.id;
}

async function waitForCommit(commit, ms) {
  const until = Date.now() + ms;
  let last = '';
  while (Date.now() < until) {
    try {
      const r = await fetch(`${TARGET.url}/api/version`, { cache: 'no-store' });
      const j = await r.json();
      last = (j.version && j.version.commit) || '';
      if (last === commit) return { ok: true, last };
    } catch (e) { last = `error: ${e.message}`; }
    await new Promise((res) => setTimeout(res, 15000));
  }
  return { ok: false, last };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); return; }
  const now = process.env.LANTERN_NOW ? new Date(process.env.LANTERN_NOW) : new Date();
  if (o.yes && !o.force && inSession(now)) {
    console.error("railway-deploy: the US session is open (Mon-Fri 09:25-16:05 ET), and a deploy restarts the users' trader. Ship after the close, or add --force for an urgent fix.");
    process.exit(2);
  }
  if (o.ref.startsWith('origin/')) run('git', ['fetch', '-q', 'origin', o.ref.slice('origin/'.length)]);
  const commit = run('git', ['rev-parse', '--verify', `${o.ref}^{commit}`]);
  const subject = run('git', ['log', '-1', '--format=%s', commit]);
  const date = run('git', ['log', '-1', '--format=%cI', commit]);
  const by = run('git', ['config', 'user.name'], { allowFail: true }) || os.userInfo().username;
  const dir = path.join(os.tmpdir(), `unisona-deploy-${commit.slice(0, 12)}`);
  if (fs.existsSync(dir)) run('git', ['worktree', 'remove', '--force', dir], { allowFail: true });
  run('git', ['worktree', 'add', '--detach', dir, commit]);
  try {
    const pointers = lfsPointersIn(dir);
    if (pointers.length) throw new Error(`images came out as Git LFS pointer files (e.g. ${pointers[0]}): install git-lfs, run "git lfs pull", then retry`);
    const info = buildInfo({ commit, ref: o.ref, date, subject, by, at: new Date().toISOString() });
    fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
    console.log(`ship ${commit.slice(0, 8)} "${subject}"  (${o.ref}, committed ${date})`);
    console.log(`  to Railway ${TARGET.project} / ${TARGET.service} / ${TARGET.environment}  ->  ${TARGET.url}`);
    if (!o.yes) { console.log('plan only: nothing uploaded. Re-run with --yes to deploy.'); return; }
    const up = railway(['up', dir, '--project', projectId(TARGET.project), '--service', TARGET.service, '--environment', TARGET.environment, '--detach', '--yes'], { cwd: dir, stdio: 'inherit' });
    if (up.status !== 0) throw new Error(`railway up exited ${up.status}`);
    console.log('uploaded; waiting for production to report the new commit (up to 15 min)...');
    const w = await waitForCommit(commit, 15 * 60 * 1000);
    if (w.ok) console.log(`live: ${TARGET.url} runs ${commit.slice(0, 8)}`);
    else { console.log(`not confirmed within 15 min (last seen: ${w.last || 'nothing'}). Check: railway deployment list --service ${TARGET.service} --environment ${TARGET.environment}`); process.exitCode = 1; }
  } finally {
    run('git', ['worktree', 'remove', '--force', dir], { allowFail: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(`railway-deploy: ${e.message}`); process.exit(1); });
}
