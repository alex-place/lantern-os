const fs = require('fs');
const path = require('path');
const Busboy = require('busboy');
const { requireEntitlement } = require('../lib/auth-middleware');

function getIngestBase(repoRoot) {
  return path.join(repoRoot, 'data', 'ingest');
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
  const { sendJson, repoRoot } = deps;
  const ingestBase = getIngestBase(repoRoot);

  // GET /api/pdfs — list all unique PDFs
  if (url.pathname === '/api/pdfs' && req.method === 'GET') {
    const pdfs = scanPdfs(ingestBase, repoRoot);
    const pubDates = loadPublicationDates(repoRoot);

    const seen = new Set();
    const unique = pdfs.filter(p => {
      const key = p.filename.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(({ absolutePath, ...rest }) => {
      const meta = pubDates[rest.filename.toLowerCase()] || {};
      return { ...rest, publishedAt: meta.publishedAt || null, pdfTitle: meta.pdfTitle || null };
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
