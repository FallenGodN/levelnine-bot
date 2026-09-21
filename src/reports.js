'use strict';
const T = require('./time');

function add(db, r) {
  const res = db.prepare(`INSERT INTO reports (emp_id, telegram_id, author, date, kind, file_id, file_unique_id, file_name, mime, size, local_path, comment)
    VALUES (@emp_id, @telegram_id, @author, @date, @kind, @file_id, @file_unique_id, @file_name, @mime, @size, @local_path, @comment)`)
    .run({ emp_id: null, telegram_id: null, author: null, file_id: null, file_unique_id: null, file_name: null, mime: null, size: null, local_path: null, comment: null, ...r });
  return byId(db, res.lastInsertRowid);
}
function byId(db, id) { return db.prepare('SELECT * FROM reports WHERE id = ?').get(id) || null; }
function recent(db, n = 10) { return db.prepare('SELECT * FROM reports ORDER BY created_at DESC, id DESC LIMIT ?').all(n); }
function onDate(db, date) { return db.prepare('SELECT * FROM reports WHERE date = ? ORDER BY created_at').all(date); }
function between(db, from, to) { return db.prepare('SELECT * FROM reports WHERE date >= ? AND date <= ? ORDER BY created_at DESC, id DESC').all(from, to); }
function setComment(db, id, comment) { db.prepare('UPDATE reports SET comment = ? WHERE id = ?').run(comment, id); }

const KIND = { photo: '📷 фото', document: '📎 документ', text: '📝 текст' };
function line(r) {
  const name = r.file_name ? ` ${r.file_name}` : '';
  return `#${r.id} · ${T.uaDateTime(r.created_at)} · ${KIND[r.kind] || r.kind}${name} · ${r.author || '—'}${r.comment ? '\n   ' + r.comment : ''}`;
}

module.exports = { add, byId, recent, onDate, between, setComment, line };
