'use strict';
// Витягання тексту з касових документів. Повертає null, якщо прочитати не вдалося.
const fs = require('fs');
const path = require('path');

const MAX = 14000;

async function extractText(localPath, mime = '', fileName = '') {
  if (!localPath || !fs.existsSync(localPath)) return null;
  const ext = path.extname(fileName || localPath).toLowerCase();
  try {
    if (['.xlsx', '.xlsm', '.xls', '.csv', '.ods'].includes(ext) || /spreadsheet|excel|csv/.test(mime)) {
      const XLSX = require('xlsx');
      const wb = XLSX.readFile(localPath, { cellDates: true });
      let out = '';
      for (const name of wb.SheetNames) {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
        if (csv.trim()) out += `=== Аркуш: ${name} ===\n${csv}\n`;
        if (out.length > MAX) break;
      }
      return out.trim() ? out.slice(0, MAX) : null;
    }
    if (ext === '.pdf' || mime === 'application/pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(fs.readFileSync(localPath));
      const text = (data.text || '').replace(/\s+\n/g, '\n').trim();
      return text ? text.slice(0, MAX) : null; // сканований PDF без тексту → null
    }
    if (['.txt', '.md', '.json'].includes(ext) || /^text\//.test(mime)) {
      const text = fs.readFileSync(localPath, 'utf8').trim();
      return text ? text.slice(0, MAX) : null;
    }
  } catch (e) {
    console.error('extract failed', localPath, e.message);
  }
  return null;
}

const isImage = (mime = '', fileName = '') => /^image\//.test(mime) || /\.(jpe?g|png|webp)$/i.test(fileName || '');

module.exports = { extractText, isImage };
