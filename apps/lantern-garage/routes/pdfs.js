const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Busboy = require('busboy');
const { requireEntitlement } = require('../lib/auth-middleware');

function getIngestBase(repoRoot) {
  return path.join(repoRoot, 'data', 'ingest');
}

// ── CSF condensed-corpus backing ──────────────────────────────────────────
// The intake/research dump corpus was folded into one lossless CSF archive
// (scripts/csf_condense_corpus.py) and the loose originals removed. The PDF
// library is reconstructed from the committed manifest (works on every node)
// and individual PDFs are streamed out of the archive on demand. The manifest
// is small + tracked; the .csf blob is large + gitignored, so it must be
// present locally for byte serving — if it is absent the list still shows but
// /api/pdfs/file returns 503 (archived-not-available) rather than a hard break.
function findManifest(repoRoot) {
  const dir = path.join(repoRoot, 'data', 'csf_archives');
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.manifest.json')); } catch { return null; }
  if (!files.length) return null;
  files.sort(); // dated names → newest last
  return path.join(dir, files[files.length - 1]);
}

// Returns { archiveAbs, present, byFilename: Map(lowerName -> entry) } or null.
function loadArchiveIndex(repoRoot) {
  const manifestPath = findManifest(repoRoot);
  if (!manifestPath) return null;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch { return null; }
  const archiveAbs = path.resolve(repoRoot, manifest.archive || '');
  const byFilename = new Map();
  for (const [origPath, info] of Object.entries(manifest.members || {})) {
    if (!origPath.toLowerCase().endsWith('.pdf')) continue;
    const filename = path.basename(origPath);
    const key = filename.toLowerCase();
    if (byFilename.has(key)) continue; // first wins (dedup by basename)
    const ingestRel = origPath.startsWith('data/ingest/')
      ? path.dirname(origPath).slice('data/ingest/'.length) : '';
    byFilename.set(key, {
      name: path.basename(filename, '.pdf'),
      filename,
      member: info.member,
      folder: ingestRel,
      source: 'csf-archive',
    });
  }
  return { archiveAbs, present: fs.existsSync(archiveAbs), byFilename };
}

// Stream one PDF member out of the archive. Fixed argv (python + script + 2
// positional args), shell:false — no shell, no injection surface. Returns a
// Buffer or throws.
function readPdfFromArchive(repoRoot, archiveAbs, member) {
  const python = process.env.PYTHON_BIN || 'python';
  const script = path.join(repoRoot, 'scripts', 'csf_read_member.py');
  return execFileSync(python, [script, archiveAbs, member], {
    maxBuffer: 128 * 1024 * 1024, // largest corpus PDF ~61 MB
    windowsHide: true,
  });
}

function loadPublicationDates(repoRoot) {
  try {
    const manifest = path.join(repoRoot, 'data', 'tesseract', 'manifest.json');
    if (!fs.existsSync(manifest)) return {};
    const { docs } = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
    const map = {};
    for (const d of (docs || [])) {
      if (d.filename) map[d.filename.toLowerCase()] = { publishedAt: d.publishedAt || null, pdfTitle: d.pdfTitle || null };
    }
    return map;
  } catch { return {}; }
}

// Some ingested PDFs carry a junk metadata title ("(anonymous)", blank, or
// whitespace) extracted from the file's /Author or /Title. Treat those as no
// title so the UI falls back to the human-readable filename instead.
function cleanPdfTitle(t) {
  if (!t) return null;
  const s = String(t).trim();
  if (!s) return null;
  if (/^\(?\s*anonymous\s*\)?$/i.test(s)) return null;
  return s;
}

function scanPdfs(ingestBase, repoRoot) {
  const pdfs = [];

  function scan(dir) {
    if (!fs.existsSync(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
        const relative = path.relative(repoRoot, full).replace(/\\/g, '/');
        const folder = path.relative(ingestBase, path.dirname(full)).replace(/\\/g, '/');
        let stat = null;
        try { stat = fs.statSync(full); } catch { /* ignore */ }
        pdfs.push({
          name: path.basename(entry.name, '.pdf'),
          filename: entry.name,
          absolutePath: full,
          repoPath: '/repo/' + relative.split('/').map(encodeURIComponent).join('/'),
          folder,
          size: stat ? stat.size : null,
          createdAt: stat ? (stat.birthtime || stat.ctime).toISOString() : null,
          modifiedAt: stat ? stat.mtime.toISOString() : null,
        });
      }
    }
  }

  scan(ingestBase);
  return pdfs;
}

module.exports = async function pdfRoutes(req, res, url, deps) {
  const { sendJson, sendFile, repoRoot } = deps;
  const ingestBase = getIngestBase(repoRoot);

  // GET /api/pdfs — list all unique PDFs (live ingest dir + CSF archive)
  if (url.pathname === '/api/pdfs' && req.method === 'GET') {
    const pdfs = scanPdfs(ingestBase, repoRoot);
    const pubDates = loadPublicationDates(repoRoot);

    // Merge in PDFs that now live only in the condensed CSF archive. Live files
    // (still on disk) take precedence; archive entries fill in the rest.
    const archive = loadArchiveIndex(repoRoot);
    if (archive) {
      const live = new Set(pdfs.map(p => p.filename.toLowerCase()));
      for (const [key, e] of archive.byFilename) {
        if (live.has(key)) continue;
        pdfs.push({
          name: e.name, filename: e.filename, absolutePath: null,
          repoPath: null, folder: e.folder, size: null,
          createdAt: null, modifiedAt: null, source: e.source,
        });
      }
    }

    const seen = new Set();
    const unique = pdfs.filter(p => {
      const key = p.filename.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(({ absolutePath, ...rest }) => {
      const meta = pubDates[rest.filename.toLowerCase()] || {};
      return {
        ...rest,
        // Working download URL. The generic /repo handler denies data/ingest as a
        // PII pool (#868), so PDFs are served via this curated endpoint instead.
        fileUrl: '/api/pdfs/file?filename=' + encodeURIComponent(rest.filename),
        publishedAt: meta.publishedAt || null,
        pdfTitle: cleanPdfTitle(meta.pdfTitle),
      };
    });

    // Sort: PDF publication date → file modification date → alphabetical
    unique.sort((a, b) => {
      const da = a.publishedAt || a.modifiedAt || a.createdAt || '';
      const db = b.publishedAt || b.modifiedAt || b.createdAt || '';
      if (da && db) return db.localeCompare(da);
      if (da) return -1;
      if (db) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    sendJson(res, { pdfs: unique, total: unique.length });
    return true;
  }

  // GET /api/pdfs/file?filename=<name> — serve a PDF from the research pool.
  // The generic /repo handler denies data/ingest as a PII pool (#868); this curated
  // endpoint serves only .pdf files from inside ingestBase, mirroring the public
  // read-only list above so the Knowledge Center links actually resolve.
  if (url.pathname === '/api/pdfs/file' && req.method === 'GET') {
    const filename = url.searchParams.get('filename') || '';
    if (!filename || filename.includes('/') || filename.includes('\\') || !filename.toLowerCase().endsWith('.pdf')) {
      sendJson(res, { error: 'invalid filename' }, 400);
      return true;
    }
    const match = scanPdfs(ingestBase, repoRoot).find(p => p.filename.toLowerCase() === filename.toLowerCase());
    if (match) {
      // Boundary: only ever serve a real .pdf from inside the ingest pool.
      const resolved = path.resolve(match.absolutePath);
      if (!resolved.startsWith(path.resolve(ingestBase) + path.sep) || path.extname(resolved).toLowerCase() !== '.pdf') {
        sendJson(res, { error: 'forbidden' }, 403);
        return true;
      }
      sendFile(res, resolved);
      return true;
    }

    // Not on disk — try the condensed CSF archive.
    const archive = loadArchiveIndex(repoRoot);
    const entry = archive && archive.byFilename.get(filename.toLowerCase());
    if (!entry) { sendJson(res, { error: 'not_found' }, 404); return true; }
    if (!archive.present) {
      sendJson(res, { error: 'archived', detail: 'CSF archive not available on this node' }, 503);
      return true;
    }
    let buf;
    try {
      buf = readPdfFromArchive(repoRoot, archive.archiveAbs, entry.member);
    } catch (e) {
      sendJson(res, { error: 'archive_read_failed', detail: String(e.message || e) }, 500);
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': buf.length,
      'Content-Disposition': 'inline; filename="' + filename.replace(/[^a-zA-Z0-9._\- ]/g, '_') + '"',
    });
    res.end(buf);
    return true;
  }

  // DELETE /api/pdfs?filename=<name> — remove all copies of a file from all ingest folders
  if (url.pathname === '/api/pdfs' && req.method === 'DELETE') {
    // Mutating endpoint — gate behind the pdf_admin entitlement (admins + local
    // bypass auto-pass; read-only GET stays public). #866
    if (!requireEntitlement(req, res, 'pdf_admin')) return true;
    const filename = url.searchParams.get('filename');
    if (!filename || filename.includes('/') || filename.includes('\\') || !filename.toLowerCase().endsWith('.pdf')) {
      sendJson(res, { error: 'invalid filename' }, 400);
      return true;
    }

    const allPdfs = scanPdfs(ingestBase, repoRoot);
    const matches = allPdfs.filter(p => p.filename.toLowerCase() === filename.toLowerCase());

    if (!matches.length) {
      sendJson(res, { error: 'not_found' }, 404);
      return true;
    }

    const deleted = [];
    const errors = [];
    for (const match of matches) {
      // Safety: ensure path stays inside ingest folder
      if (!match.absolutePath.startsWith(ingestBase)) {
        errors.push({ path: match.absolutePath, error: 'outside ingest boundary' });
        continue;
      }
      try {
        fs.unlinkSync(match.absolutePath);
        deleted.push(match.absolutePath);
      } catch (e) {
        errors.push({ path: match.absolutePath, error: e.message });
      }
    }

    sendJson(res, { deleted: deleted.length, errors, filename });
    return true;
  }

  // POST /api/pdfs/upload — save uploaded PDFs to data/ingest/
  if (url.pathname === '/api/pdfs/upload' && req.method === 'POST') {
    // Mutating endpoint — gate behind the pdf_admin entitlement before any body
    // parsing (rejects an unentitled 100 MB upload up front). #866
    if (!requireEntitlement(req, res, 'pdf_admin')) return true;
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('multipart/form-data')) {
      sendJson(res, { error: 'multipart/form-data required' }, 400);
      return true;
    }
    const saved = [];
    const errors = [];
    const writes = [];
    try { fs.mkdirSync(ingestBase, { recursive: true }); } catch { /* already exists */ }
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024 } });
    bb.on('file', (fieldname, file, info) => {
      const { filename } = info;
      if (!filename || !filename.toLowerCase().endsWith('.pdf')) {
        file.resume();
        errors.push({ filename, error: 'not a PDF' });
        return;
      }
      const safe = path.basename(filename).replace(/[^a-zA-Z0-9._\- ]/g, '_');
      const dest = path.join(ingestBase, safe);
      // Track each write so the response waits for the file to flush to disk.
      // (Busboy 1.x emits 'close' after streams drain; replying on 'finish'
      //  raced ahead of the write and reported saved:[] for files already saving.)
      writes.push(new Promise((resolve) => {
        const ws = fs.createWriteStream(dest);
        file.pipe(ws);
        ws.on('finish', () => { saved.push(safe); resolve(); });
        ws.on('error', e => { errors.push({ filename: safe, error: e.message }); resolve(); });
      }));
    });
    const respond = () => {
      Promise.all(writes).then(() => {
        if (!res.writableEnded) sendJson(res, { ok: true, saved, errors });
      });
    };
    bb.on('close', respond);
    bb.on('finish', respond);
    bb.on('error', e => { if (!res.writableEnded) sendJson(res, { ok: false, error: e.message }, 500); });
    req.pipe(bb);
    return true;
  }

  return false;
};
