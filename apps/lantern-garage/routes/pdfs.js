/**
 * PDF upload for chat attachments: POST /api/pdfs/upload saves PDFs to data/ingest/.
 *
 * The listing, file-serving and delete endpoints (GET /api/pdfs, GET /api/pdfs/file,
 * DELETE /api/pdfs) and the committed CSF corpus archives behind them were removed
 * on 2026-09-29: their only consumer was the retired Knowledge Center library page.
 */
const fs = require('fs');
const path = require('path');
const Busboy = require('busboy');
const { requireEntitlement } = require('../lib/auth-middleware');

function getIngestBase(repoRoot) {
  return path.join(repoRoot, 'data', 'ingest');
}

module.exports = async function pdfRoutes(req, res, url, deps) {
  const { sendJson, repoRoot } = deps;
  const ingestBase = getIngestBase(repoRoot);

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
