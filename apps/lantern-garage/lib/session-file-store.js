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

class FileSessionStore extends session.Store {
  constructor({ dir } = {}) {
    super();
    this.dir = dir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) { /* best-effort */ }
  }
  _file(sid) { return path.join(this.dir, encodeURIComponent(String(sid)) + ".json"); }

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
    fs.writeFile(this._file(sid), JSON.stringify({ __expires: exp, sess }), (e) => cb && cb(e));
  }

  destroy(sid, cb) { fs.unlink(this._file(sid), () => cb && cb()); }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

module.exports = { FileSessionStore };
