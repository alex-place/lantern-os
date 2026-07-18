/**
 * Minimal, dependency-free file-backed express-session store.
 *
 * The default MemoryStore drops EVERY session when the process restarts — so the owner
 * got signed out of :4178 on every deploy/restart even though the cookie was still valid
 * for 7 days. This persists one small JSON file per session id, so a restart no longer
 * logs anyone out. Expiry is honored on read and swept lazily. Single-instance / local
 * -first (this app), so a plain file store is the right fit — no external service.
 */
const fs = require("fs");
const path = require("path");
const session = require("express-session");

// A touch() is a re-save just to extend expiry; express-session calls it on every
// request that loads an unmodified session. Rewriting the whole file each time is
// wasteful (#2631) — skip a touch if the session was persisted within this window.
const TOUCH_THROTTLE_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

class FileSessionStore extends session.Store {
  constructor({ dir } = {}) {
    super();
    this.dir = dir;
    this._lastSet = new Map(); // sid -> last persisted ms (touch throttle)
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) { /* best-effort */ }
    // Periodically delete expired session files. Without this, sessions that are
    // never read again (abandoned tabs) linger on disk forever — "swept lazily" only
    // swept the one sid being read (#2631). unref so it never holds the process open.
    this._sweep = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    if (this._sweep.unref) this._sweep.unref();
  }
  _file(sid) { return path.join(this.dir, encodeURIComponent(String(sid)) + ".json"); }

  /** Delete every session file whose stored expiry has passed. Best-effort, async. */
  sweepExpired() {
    fs.readdir(this.dir, (err, files) => {
      if (err) return;
      const now = Date.now();
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const fp = path.join(this.dir, f);
        fs.readFile(fp, "utf8", (e, data) => {
          if (e) return;
          let o; try { o = JSON.parse(data); } catch { return; }
          if (o && o.__expires && now > o.__expires) fs.unlink(fp, () => {});
        });
      }
      // Bound the throttle map to live sessions-ish (cheap: clear if it grows large).
      if (this._lastSet.size > 10000) this._lastSet.clear();
    });
  }

  get(sid, cb) {
    fs.readFile(this._file(sid), "utf8", (err, data) => {
      if (err) return cb(null, null); // missing → no session (not an error)
      let o; try { o = JSON.parse(data); } catch (_e) { return cb(null, null); }
      if (o && o.__expires && Date.now() > o.__expires) {
        fs.unlink(this._file(sid), () => {});
        return cb(null, null);
      }
      cb(null, (o && o.sess) || null);
    });
  }

  set(sid, sess, cb) {
    const exp = sess && sess.cookie && sess.cookie.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + 7 * 24 * 60 * 60 * 1000;
    this._lastSet.set(String(sid), Date.now());
    fs.writeFile(this._file(sid), JSON.stringify({ __expires: exp, sess }), (e) => cb && cb(e));
  }

  destroy(sid, cb) { this._lastSet.delete(String(sid)); fs.unlink(this._file(sid), () => cb && cb()); }

  // touch() only extends expiry — throttle it so an unmodified session isn't rewritten
  // to disk on every request (#2631). The 7-day cookie tolerates a 10-min-stale expiry.
  touch(sid, sess, cb) {
    const last = this._lastSet.get(String(sid)) || 0;
    if (Date.now() - last < TOUCH_THROTTLE_MS) return cb && cb();
    this.set(sid, sess, cb);
  }
}

/**
 * Force-invalidate every persisted session belonging to a user id (synchronous; the
 * session dir is small and this runs only on rare privileged actions). Used when a role
 * or entitlement is changed out-of-band so an established session can't keep stale
 * privileges until it naturally expires (#2627) — the user is signed out and must
 * re-authenticate, picking up the new role. Returns the count removed.
 */
function destroyUserSessions(dir, userId) {
  if (!dir || userId == null) return 0;
  let files;
  try { files = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const fp = path.join(dir, f);
    try {
      const o = JSON.parse(fs.readFileSync(fp, "utf8"));
      const uid = o && o.sess && o.sess.user && o.sess.user.id;
      if (uid != null && String(uid) === String(userId)) { fs.unlinkSync(fp); removed++; }
    } catch { /* unreadable/rotating file — skip */ }
  }
  return removed;
}

module.exports = { FileSessionStore, destroyUserSessions };
