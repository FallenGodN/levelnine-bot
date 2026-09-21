'use strict';
const config = require('./config');
const T = require('./time');

/** Чи момент часу поза графіком контролю присутності. */
function outsideSchedule(d = new Date()) {
  const p = T.parts(d);
  const win = config.schedule[p.wd];
  if (!win) return true;
  return p.time < win[0] || p.time > win[1];
}
function scheduleText() {
  return 'Пн–Пт 08:00–22:00 · Сб 09:00–18:00 · Нд 09:00–16:00';
}

function openShiftOf(db, empId) {
  return db.prepare('SELECT * FROM shifts WHERE emp_id = ? AND ended_at IS NULL').get(empId) || null;
}

/** Відмітка приходу. Друга відмітка поспіль не створює нову зміну. */
function start(db, emp, now = new Date()) {
  const existing = openShiftOf(db, emp.id);
  if (existing) return { dup: true, shift: existing };
  const p = T.parts(now);
  const outside = outsideSchedule(now) ? 1 : 0;
  try {
    const r = db.prepare('INSERT INTO shifts (emp_id, date, started_at, start_outside) VALUES (?, ?, ?, ?)')
      .run(emp.id, p.date, T.iso(now), outside);
    return { dup: false, outside: !!outside, shift: db.prepare('SELECT * FROM shifts WHERE id = ?').get(r.lastInsertRowid) };
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return { dup: true, shift: openShiftOf(db, emp.id) };
    throw e;
  }
}

/** Відмітка виходу. */
function end(db, emp, now = new Date()) {
  const open = openShiftOf(db, emp.id);
  if (!open) return { none: true };
  const outside = outsideSchedule(now) ? 1 : 0;
  db.prepare('UPDATE shifts SET ended_at = ?, end_outside = ? WHERE id = ? AND ended_at IS NULL').run(T.iso(now), outside, open.id);
  return { none: false, outside: !!outside, shift: db.prepare('SELECT * FROM shifts WHERE id = ?').get(open.id) };
}

/** Автозакриття: усе, що відкрите довше за autoCloseHours. Повертає закриті зміни. */
function autoClose(db, now = new Date()) {
  const limit = new Date(now.getTime() - config.autoCloseHours * 3600000).toISOString();
  const rows = db.prepare('SELECT s.*, e.name FROM shifts s JOIN employees e ON e.id = s.emp_id WHERE s.ended_at IS NULL AND s.started_at <= ?').all(limit);
  const upd = db.prepare('UPDATE shifts SET ended_at = ?, auto_closed = 1 WHERE id = ? AND ended_at IS NULL');
  const closed = [];
  for (const s of rows) {
    const endAt = new Date(new Date(s.started_at).getTime() + config.autoCloseHours * 3600000).toISOString();
    if (upd.run(endAt, s.id).changes) closed.push({ ...s, ended_at: endAt, auto_closed: 1 });
  }
  return closed;
}

function working(db) {
  return db.prepare('SELECT s.*, e.name FROM shifts s JOIN employees e ON e.id = s.emp_id WHERE s.ended_at IS NULL ORDER BY s.started_at').all();
}
function onDate(db, date) {
  return db.prepare('SELECT s.*, e.name FROM shifts s JOIN employees e ON e.id = s.emp_id WHERE s.date = ? ORDER BY s.started_at').all(date);
}
function forEmployee(db, empId, from, to) {
  return db.prepare('SELECT * FROM shifts WHERE emp_id = ? AND date >= ? AND date <= ? ORDER BY started_at DESC').all(empId, from, to);
}
function recent(db, n = 30, empId = null) {
  return empId
    ? db.prepare('SELECT s.*, e.name FROM shifts s JOIN employees e ON e.id = s.emp_id WHERE emp_id = ? ORDER BY started_at DESC LIMIT ?').all(empId, n)
    : db.prepare('SELECT s.*, e.name FROM shifts s JOIN employees e ON e.id = s.emp_id ORDER BY started_at DESC LIMIT ?').all(n);
}
function byId(db, id) { return db.prepare('SELECT s.*, e.name FROM shifts s JOIN employees e ON e.id = s.emp_id WHERE s.id = ?').get(id) || null; }

/** Виправлення адміністратором: час початку / кінця (ISO) або видалення. */
function edit(db, id, { started_at, ended_at, note }, adminId) {
  const s = byId(db, id);
  if (!s) return { ok: false, reason: 'Зміну не знайдено' };
  const newStart = started_at || s.started_at;
  const newEnd = ended_at === undefined ? s.ended_at : ended_at;
  if (newEnd && new Date(newEnd) <= new Date(newStart)) return { ok: false, reason: 'Кінець зміни має бути пізніше за початок' };
  if (!newEnd && s.ended_at) {
    const other = openShiftOf(db, s.emp_id);
    if (other && other.id !== id) return { ok: false, reason: 'У працівника вже є відкрита зміна' };
  }
  db.prepare('UPDATE shifts SET started_at = ?, date = ?, ended_at = ?, auto_closed = 0, edited_by = ?, edit_note = ? WHERE id = ?')
    .run(newStart, T.parts(new Date(newStart)).date, newEnd, adminId, note || null, id);
  db.audit(adminId, 'shift.edit', { id, from: { started_at: s.started_at, ended_at: s.ended_at }, to: { started_at: newStart, ended_at: newEnd }, note });
  return { ok: true, shift: byId(db, id) };
}
function remove(db, id, adminId) {
  const s = byId(db, id);
  if (!s) return { ok: false, reason: 'Зміну не знайдено' };
  db.prepare('DELETE FROM shifts WHERE id = ?').run(id);
  db.audit(adminId, 'shift.delete', s);
  return { ok: true, shift: s };
}
/** Ручне створення зміни адміністратором (працівник забув відмітитись). */
function create(db, empId, startedIso, endedIso, adminId) {
  if (endedIso && new Date(endedIso) <= new Date(startedIso)) return { ok: false, reason: 'Кінець зміни має бути пізніше за початок' };
  if (!endedIso && openShiftOf(db, empId)) return { ok: false, reason: 'У працівника вже є відкрита зміна' };
  const r = db.prepare('INSERT INTO shifts (emp_id, date, started_at, ended_at, edited_by, edit_note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(empId, T.parts(new Date(startedIso)).date, startedIso, endedIso || null, adminId, 'створено вручну');
  db.audit(adminId, 'shift.create', { id: r.lastInsertRowid, empId, startedIso, endedIso });
  return { ok: true, shift: byId(db, r.lastInsertRowid) };
}

function line(s) {
  const st = T.uaTime(s.started_at);
  const en = s.ended_at ? T.uaTime(s.ended_at) : '…';
  const tags = [];
  if (s.auto_closed) tags.push('автозакрито');
  if (s.start_outside || s.end_outside) tags.push('поза графіком');
  if (s.edited_by) tags.push('виправлено');
  const dur = s.ended_at ? ` (${T.durText(s.started_at, s.ended_at)})` : '';
  return `${T.uaDate(s.date)} ${st}–${en}${dur}${tags.length ? ' · ' + tags.join(', ') : ''}`;
}

module.exports = { outsideSchedule, scheduleText, openShiftOf, start, end, autoClose, working, onDate, forEmployee, recent, byId, edit, remove, create, line };
