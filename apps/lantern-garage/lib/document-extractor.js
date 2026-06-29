const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const ExifParser = require('exif-parser');

// Extract text from PDF (fast path for text-based PDFs, fallback to OCR)
async function extractPdfText(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(buffer).catch(err => {
      throw new Error(`PDF parsing failed: ${err.message}`);
    });

    const text = pdfData.text || '';

    // If extracted text is too sparse, likely scanned PDF - skip OCR (too slow)
    if (text.length < 100 || (text.match(/\s{4,}/g) || []).length > text.length * 0.1) {
      return {
        method: 'skipped-scanned',
        content: text.trim(),
        pages: pdfData.numpages || 1,
        confidence: 0.6,
        metadata: {
          title: pdfData.info?.Title || null,
          author: pdfData.info?.Author || null,
          createdAt: pdfData.info?.CreationDate || null,
          modifiedAt: pdfData.info?.ModDate || null
        }
      };
    }

    return {
      method: 'textract',
      content: text.trim(),
      pages: pdfData.numpages || 1,
      confidence: 0.95,
      metadata: {
        title: pdfData.info?.Title || null,
        author: pdfData.info?.Author || null,
        subject: pdfData.info?.Subject || null,
        createdAt: pdfData.info?.CreationDate || null,
        modifiedAt: pdfData.info?.ModDate || null,
        producer: pdfData.info?.Producer || null
      }
    };
  } catch (err) {
    console.error(`[pdf-parse] ${err.message}`);
    return {
      method: 'error',
      content: '',
      confidence: 0,
      error: `PDF extraction failed: ${err.message}`
    };
  }
}

// Extract text from a Word .docx (mammoth → raw text; preserves paragraphs)
async function extractDocxText(filePath) {
  try {
    const mammoth = require('mammoth');
    const { value, messages } = await mammoth.extractRawText({ path: filePath });
    const text = (value || '').trim();
    return {
      method: 'mammoth',
      content: text,
      confidence: text ? 0.95 : 0,
      error: text ? null : 'No extractable text in .docx',
      warnings: (messages || []).map(m => m.message).slice(0, 5),
    };
  } catch (err) {
    return { method: 'error', content: '', confidence: 0, error: `DOCX extraction failed: ${err.message}` };
  }
}

// Extract text from an Excel .xlsx/.xls (exceljs → tab-separated rows per sheet)
async function extractSpreadsheetText(filePath) {
  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const parts = [];
    wb.eachSheet(sheet => {
      const rows = [];
      sheet.eachRow({ includeEmpty: false }, row => {
        const cells = (row.values || []).slice(1).map(v => {
          if (v == null) return '';
          if (typeof v === 'object') return v.text != null ? v.text : (v.result != null ? v.result : (v.hyperlink || ''));
          return String(v);
        });
        rows.push(cells.join('\t'));
      });
      if (rows.length) parts.push(`# Sheet: ${sheet.name}\n${rows.join('\n')}`);
    });
    const text = parts.join('\n\n').trim();
    return {
      method: 'exceljs',
      content: text,
      confidence: text ? 0.9 : 0,
      error: text ? null : 'No cells with content',
    };
  } catch (err) {
    return { method: 'error', content: '', confidence: 0, error: `XLSX extraction failed: ${err.message}` };
  }
}

// Extract text from a PowerPoint .pptx (jszip → strip <a:t> runs from each slide)
async function extractPptxText(filePath) {
  try {
    const JSZip = require('jszip');
    const buffer = fs.readFileSync(filePath);
    const zip = await JSZip.loadAsync(buffer);
    const slideNames = Object.keys(zip.files)
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => (parseInt(a.match(/(\d+)/)[1], 10) - parseInt(b.match(/(\d+)/)[1], 10)));
    const parts = [];
    for (let i = 0; i < slideNames.length; i++) {
      const xml = await zip.file(slideNames[i]).async('string');
      const runs = (xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) || [])
        .map(t => t.replace(/<\/?a:t>/g, ''))
        .map(s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"))
        .filter(Boolean);
      if (runs.length) parts.push(`# Slide ${i + 1}\n${runs.join('\n')}`);
    }
    const text = parts.join('\n\n').trim();
    return {
      method: 'pptx-jszip',
      content: text,
      confidence: text ? 0.85 : 0,
      error: text ? null : 'No extractable text in .pptx',
    };
  } catch (err) {
    return { method: 'error', content: '', confidence: 0, error: `PPTX extraction failed: ${err.message}` };
  }
}

// OCR fallback for scanned PDFs/images
async function ocrImage(imagePath) {
  try {
    const { data: { text, confidence } } = await Tesseract.recognize(imagePath, 'eng');
    return {
      method: 'ocr',
      content: text.trim(),
      confidence: Math.min(0.95, confidence / 100) || 0.88
    };
  } catch (err) {
    console.error(`[Tesseract] OCR failed: ${err.message}`);
    return {
      method: 'error',
      content: '',
      confidence: 0,
      error: err.message
    };
  }
}

// Convert PDF to images and OCR each page
async function ocrPdfPages(filePath) {
  // PDF→image→OCR is complex and slow; for now return empty with warning
  // In production, use: pdf2image + Tesseract, or AWS Textract for scanned PDFs
  return {
    method: 'error',
    content: '',
    confidence: 0,
    error: 'Scanned PDF detected. PDF→OCR pipeline requires pdf-image or cloud API. Skipping.'
  };
}

// Extract file-level metadata
async function extractFileMetadata(filePath) {
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();

  const metadata = {
    fileName: path.basename(filePath),
    filePath: filePath,
    size: stat.size,
    createdAt: stat.birthtime,
    modifiedAt: stat.mtime,
    extension: ext
  };

  // Extract EXIF from images
  if (['.png', '.jpg', '.jpeg', '.tiff'].includes(ext)) {
    try {
      const buffer = fs.readFileSync(filePath);
      const parser = new ExifParser.Parser();
      const result = parser.parseBuffer(buffer);

      metadata.exif = {
        datetime: result.tags?.DateTime || null,
        camera: result.tags?.Model || null,
        width: result.tags?.ImageWidth || null,
        height: result.tags?.ImageHeight || null,
        orientation: result.tags?.Orientation || null
      };
    } catch (err) {
      // EXIF extraction optional; don't fail on error
      metadata.exif = null;
    }
  }

  return metadata;
}

// Main extraction function - routes to appropriate handler
async function extractDocumentContent(filePath, mimeType = null) {
  const ext = path.extname(filePath).toLowerCase();

  try {
    if (ext === '.pdf') {
      return await extractPdfText(filePath);
    }

    if (ext === '.docx') {
      return await extractDocxText(filePath);
    }

    if (ext === '.xlsx' || ext === '.xlsm') {
      return await extractSpreadsheetText(filePath);
    }

    if (ext === '.pptx') {
      return await extractPptxText(filePath);
    }

    if (['.png', '.jpg', '.jpeg', '.tiff', '.gif', '.webp'].includes(ext)) {
      return await ocrImage(filePath);
    }

    // Plain-text-like formats read straight off disk.
    if (['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.xml',
         '.html', '.htm', '.yaml', '.yml', '.rtf'].includes(ext)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return {
        method: 'fs',
        content: content.trim(),
        confidence: 1.0
      };
    }

    return {
      method: 'unsupported',
      content: '',
      confidence: 0,
      error: `Unsupported file type: ${ext}`
    };
  } catch (err) {
    return {
      method: 'error',
      content: '',
      confidence: 0,
      error: err.message
    };
  }
}

module.exports = {
  extractDocumentContent,
  extractFileMetadata,
  extractPdfText,
  extractDocxText,
  extractSpreadsheetText,
  extractPptxText,
  ocrImage,
  ocrPdfPages
};
