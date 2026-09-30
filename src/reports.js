'use strict';
const T = require('./time');

// category: cash (звіт каси) | photo (фото-звіт) | problem (проблема); status для проблем: new | done
function add(db, r) {
  const res = db.prepare(`INSERT INTO reports (emp_id, telegram_id, author, date, kind, category, status, file_id, file_unique_id, file_name, mime, size, local_path, comment)
    VALUES (@emp_id, @telegram_id, @author, @date, @kind, @category, @status, @file_id, @file_unique_id, @file_name, @mime, @size, @local_path, @comment)`)
    .run({ emp_id: null, telegram_id: null, author: null, category: 'cash', status: 'new', file_id: null, file_unique_id: null, file_name: null, mime: null, size: null, local_path: null, comment: null, ...r });
  return byId(db, res.lastInsertRowid);
}
function byId(db, id) { return db.prepare('SELECT * FROM reports WHERE id = ?').get(id) || null; }
const catSql = (cat) => (cat ? ' AND category = ?' : '');
function recent(db, n = 10, cat = null) { return db.prepare(`SELECT * FROM reports WHERE 1=1${catSql(cat)} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...(cat ? [cat, n] : [n])); }
function onDate(db, date, cat = null) { return db.prepare(`SELECT * FROM reports WHERE date = ?${catSql(cat)} ORDER BY created_at, id`).all(...(cat ? [date, cat] : [date])); }
function between(db, from, to, cat = null) { return db.prepare(`SELECT * FROM reports WHERE date >= ? AND date <= ?${catSql(cat)} ORDER BY created_at DESC, id DESC`).all(...(cat ? [from, to, cat] : [from, to])); }
function openProblems(db) { return db.prepare("SELECT * FROM reports WHERE category = 'problem' AND status = 'new' ORDER BY created_at DESC, id DESC").all(); }
function setComment(db, id, comment) { db.prepare('UPDATE reports SET comment = ? WHERE id = ?').run(comment, id); }
function setStatus(db, id, status) { db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, id); }

const KIND = { photo: '📷 фото', video: '🎥 відео', document: '📎 документ', text: '📝 текст' };
const CAT = { cash: '💵 Звіт каси', photo: '📷 Фото-звіт', problem: '🚨 Проблема' };
function line(r) {
  const name = r.file_name ? ` ${r.file_name}` : '';
  const st = r.category === 'problem' ? (r.status === 'done' ? ' · ✅ вирішено' : ' · відкрито') : '';
  return `#${r.id} · ${CAT[r.category] || r.category} · ${T.uaDateTime(r.created_at)} · ${KIND[r.kind] || r.kind}${name} · ${r.author || '—'}${st}${r.comment ? '\n   ' + r.comment : ''}`;
}

module.exports = { add, byId, recent, onDate, between, openProblems, setComment, setStatus, line, CAT, KIND };
