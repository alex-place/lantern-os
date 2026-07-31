'use strict';

/**
 * account-lock.js — one broker account is managed by exactly ONE process at a time.
 *
 * WHY THIS EXISTS
 * On 2026-07-31 two servers (:4177 stable and :4178 dev) both ran the autonomous scan
 * loop against the SAME IBKR account, DUR193395. Each keeps its own in-memory cooldowns
 * and its own trader-state.json, so neither could see the other's orders. The result
 * was duplicate submissions seconds apart, mirrored exit rows in both ledgers, and a
 * TLT long that went through flat into an unintended short.
 *
 * The scan loop is already correct for MULTI-USER: it iterates each connected user and
 * trades that user's own account, so two customers never collide. What was missing is
 * mutual exclusion at the ACCOUNT level — which is what this provides, and which is what
 * lets several instances run for many Pilot customers without fighting over an account.
 *
 * DESIGN
 * A lock is a small JSON file per broker account id under data/trading/locks/. It holds
 * the owning pid, host, and a heartbeat. Rules:
 *
 *   - acquire() succeeds if the account is unlocked, already ours, or the holder's
 *     heartbeat is STALE (older than staleMs — a crashed process must never wedge an
 *     account forever; that would silently stop exit management on real positions).
 *   - The holder re-stamps the heartbeat on every acquire, so a live owner keeps it.
 *   - release() removes only OUR lock, never someone else's.
 *
 * Deliberately a file lock, not an OS mutex: it must work across separate node
 * processes and survive inspection (`cat` the file to see who owns an account).
 *
 * FAIL-OPEN, ON PURPOSE. If the lock directory is unreadable/unwritable we return
 * acquired:true with a reason. A broken lock file must never stop the engine from
 * managing REAL money positions — a stuck stop-loss is far worse than a double order.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_DIR = process.env.TRADER_LOCK_DIR
  ? path.resolve(process.env.TRADER_LOCK_DIR)
  : path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'locks');

// A holder that hasn't heartbeat in this long is presumed dead. Must comfortably
// exceed the scan interval (60s) so a slow-but-alive scan is never evicted.
const DEFAULT_STALE_MS = 5 * 60 * 1000;

/** Lock files are named from the account id — keep it filesystem-safe. */
function _fileFor(accountId) {
  const safe = String(accountId).replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(LOCK_DIR, safe + '.lock.json');
}

function _read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { return null; }
}

/** Identity of THIS process. host+pid is enough to distinguish the two local servers. */
function selfId() {
  return { pid: process.pid, host: os.hostname(), label: process.env.TRADER_INSTANCE || null };
}

function _isSelf(held) {
  const me = selfId();
  return !!held && held.pid === me.pid && held.host === me.host;
}

/**
 * Claim management of a broker account for this process.
 * @returns {{acquired:boolean, reason:string, heldBy?:object, staleMs:number}}
 */
function acquire(accountId, { now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  if (!accountId) return { acquired: true, reason: 'no account id — nothing to lock', staleMs };
  const file = _fileFor(accountId);
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    const held = _read(file);
    if (held && !_isSelf(held)) {
      const age = now - Number(held.heartbeat || 0);
      if (age < staleMs) {
        // Someone else owns it and is alive — stand down.
        return { acquired: false, reason: `held by pid ${held.pid}@${held.host} (${Math.round(age / 1000)}s ago)`, heldBy: held, staleMs };
      }
      // Stale: the holder died mid-session. Take over rather than leave the account
      // unmanaged — open positions still need their exits run.
      const rec = { ...selfId(), accountId, heartbeat: now, tookOverFrom: held.pid };
      fs.writeFileSync(file, JSON.stringify(rec));
      return { acquired: true, reason: `took over from stale pid ${held.pid} (${Math.round(age / 1000)}s stale)`, staleMs };
    }
    // Free, or already ours → (re)stamp the heartbeat.
    fs.writeFileSync(file, JSON.stringify({ ...selfId(), accountId, heartbeat: now }));
    return { acquired: true, reason: held ? 'renewed' : 'acquired', staleMs };
  } catch (e) {
    // Fail OPEN — see the header. Never let a lock problem strand a live position.
    return { acquired: true, reason: `lock unavailable (${e.message}) — proceeding`, staleMs };
  }
}

/** Drop our claim. Never removes a lock held by another process. */
function release(accountId) {
  if (!accountId) return false;
  const file = _fileFor(accountId);
  try {
    const held = _read(file);
    if (held && !_isSelf(held)) return false;
    fs.unlinkSync(file);
    return true;
  } catch (_e) { return false; }
}

/** Who currently holds this account (or null). Read-only — for status endpoints. */
function holder(accountId) {
  if (!accountId) return null;
  return _read(_fileFor(accountId));
}

module.exports = { acquire, release, holder, selfId, LOCK_DIR, DEFAULT_STALE_MS };
