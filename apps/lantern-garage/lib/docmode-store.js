// docmode-store.js — versioned document workspace for Keystone "Document Mode".
//
// A document is a small persisted object with an ordered list of REVISIONS (text
// snapshots). Each accepted chat turn appends a revision; `current` points at the
// active one, so Undo/rollback is just moving `current`. The internal representation
// is markdown/plain text — the diff between two revisions IS the patch.
//
// Persisted one-file-per-doc under data/documents/workspace/<id>.json so a workspace
// survives a server restart. In-memory cache avoids re-reading on every keystroke.
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..", "..");
const DIR = path.join(REPO, "data", "documents", "workspace");
const _cache = new Map();

function _ensure() { try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* exists */ } }
function _file(id) { return path.join(DIR, id + ".json"); }
function _nowId() {
  return "ws-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
}
function _persist(doc) {
  _ensure();
  try { fs.writeFileSync(_file(doc.id), JSON.stringify(doc, null, 2)); } catch (e) { /* best-effort */ }
  _cache.set(doc.id, doc);
  return doc;
}

function createDoc({ title, text }) {
  const id = _nowId();
  const doc = {
    id,
    title: (title || "Untitled document").slice(0, 200),
    createdAt: new Date().toISOString(),
    current: 0,
    revisions: [{ text: String(text || ""), ts: new Date().toISOString(), note: "Created" }],
  };
  return _persist(doc);
}

function getDoc(id) {
  if (!id || !/^ws-[a-z0-9-]+$/i.test(id)) return null;
  if (_cache.has(id)) return _cache.get(id);
  try {
    const doc = JSON.parse(fs.readFileSync(_file(id), "utf8"));
    _cache.set(id, doc);
    return doc;
  } catch { return null; }
}

function currentText(doc) {
  return (doc.revisions[doc.current] || {}).text || "";
}

// Append a new revision and make it current. Returns the updated doc.
function addRevision(id, text, note) {
  const doc = getDoc(id);
  if (!doc) return null;
  // Drop any "redo" revisions ahead of current (linear history after an edit).
  if (doc.current < doc.revisions.length - 1) {
    doc.revisions = doc.revisions.slice(0, doc.current + 1);
  }
  doc.revisions.push({ text: String(text || ""), ts: new Date().toISOString(), note: (note || "Edit").slice(0, 200) });
  doc.current = doc.revisions.length - 1;
  return _persist(doc);
}

// Move `current` to an existing revision index (Undo / rollback). Non-destructive.
function setCurrent(id, index) {
  const doc = getDoc(id);
  if (!doc) return null;
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= doc.revisions.length) return doc;
  doc.current = i;
  return _persist(doc);
}

function setTitle(id, title) {
  const doc = getDoc(id);
  if (!doc) return null;
  doc.title = String(title || doc.title).slice(0, 200);
  return _persist(doc);
}

// Public view: never leak absolute paths; include the revision list (text + meta).
function view(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    title: doc.title,
    current: doc.current,
    text: currentText(doc),
    revisions: doc.revisions.map((r, i) => ({ index: i, ts: r.ts, note: r.note, chars: (r.text || "").length })),
  };
}

module.exports = { createDoc, getDoc, currentText, addRevision, setCurrent, setTitle, view };
