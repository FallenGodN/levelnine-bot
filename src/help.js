'use strict';
// База інструкцій (🆘 Допомога): розділи → статті з текстом і скріншотами. Редагують адміністратори з бота.

function sections(db) {
  return db.prepare('SELECT section, COUNT(*) n FROM help GROUP BY section ORDER BY MIN(ord), section').all();
}
function list(db, section) {
  return db.prepare('SELECT id, section, title FROM help WHERE section = ? ORDER BY ord, id').all(section);
}
function byId(db, id) { return db.prepare('SELECT * FROM help WHERE id = ?').get(id) || null; }
function media(a) { try { return JSON.parse(a.media || '[]'); } catch (_) { return []; } }

function add(db, { section, title, body, media: m }, actorId) {
  const r = db.prepare('INSERT INTO help (section, title, body, media, updated_by) VALUES (?, ?, ?, ?, ?)').run(section.trim(), title.trim(), body || '', JSON.stringify(m || []), actorId || null);
  db.audit(actorId, 'help.add', { id: r.lastInsertRowid, section, title });
  return byId(db, r.lastInsertRowid);
}
function setBody(db, id, body, actorId) {
  db.prepare("UPDATE help SET body = ?, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(body, actorId || null, id);
  db.audit(actorId, 'help.edit', { id });
}
function addMedia(db, id, item, actorId) {
  const a = byId(db, id); if (!a) return;
  const m = media(a); m.push(item);
  db.prepare("UPDATE help SET media = ?, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(JSON.stringify(m), actorId || null, id);
}
function remove(db, id, actorId) {
  db.prepare('DELETE FROM help WHERE id = ?').run(id);
  db.audit(actorId, 'help.delete', { id });
}
function search(db, q) {
  return db.prepare('SELECT id, section, title FROM help WHERE title LIKE ? OR body LIKE ? ORDER BY section, ord, id LIMIT 20').all(`%${q}%`, `%${q}%`);
}

module.exports = { sections, list, byId, media, add, setBody, addMedia, remove, search };
