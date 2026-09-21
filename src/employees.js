'use strict';
const crypto = require('crypto');

const isAdmin = (e) => !!e && (e.role === 'admin' || e.role === 'owner');
const isOwner = (e) => !!e && e.role === 'owner';

function list(db, { activeOnly = true } = {}) {
  return db.prepare(`SELECT * FROM employees ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY role = 'owner', id`).all();
}
function byId(db, id) { return db.prepare('SELECT * FROM employees WHERE id = ?').get(id) || null; }
function byTelegram(db, tgId) { return db.prepare('SELECT * FROM employees WHERE telegram_id = ? AND active = 1').get(tgId) || null; }
function owner(db) { return db.prepare("SELECT * FROM employees WHERE role = 'owner' LIMIT 1").get() || null; }
function admins(db) { return db.prepare("SELECT * FROM employees WHERE role IN ('admin','owner') AND active = 1 AND telegram_id IS NOT NULL").all(); }

/** Прив'язати Telegram ID напряму (адміністратор ввів число). */
function link(db, empId, tgId, actorId) {
  const taken = db.prepare('SELECT id, name FROM employees WHERE telegram_id = ? AND id <> ?').get(tgId, empId);
  if (taken) return { ok: false, reason: `Цей Telegram ID вже прив'язано до «${taken.name}»` };
  db.prepare('UPDATE employees SET telegram_id = ?, link_code = NULL WHERE id = ?').run(tgId, empId);
  db.audit(actorId, 'link', { empId, tgId });
  return { ok: true };
}
function unlink(db, empId, actorId) {
  db.prepare('UPDATE employees SET telegram_id = NULL WHERE id = ?').run(empId);
  db.audit(actorId, 'unlink', { empId });
}

/** Одноразовий код: працівник надсилає його боту й прив'язується сам. */
function makeLinkCode(db, empId) {
  const code = crypto.randomInt(100000, 999999).toString();
  db.prepare('UPDATE employees SET link_code = ? WHERE id = ?').run(code, empId);
  return code;
}
function redeemCode(db, code, tgId) {
  const emp = db.prepare('SELECT * FROM employees WHERE link_code = ? AND active = 1').get(String(code).trim());
  if (!emp) return { ok: false, reason: 'Код не знайдено або вже використано' };
  const r = link(db, emp.id, tgId, null);
  return r.ok ? { ok: true, emp: byId(db, emp.id) } : r;
}

function add(db, { name, pay_type = 'daily', rate = 0, gender = 'f', role = 'employee' }, actorId) {
  const r = db.prepare('INSERT INTO employees (name, role, pay_type, rate, gender) VALUES (?, ?, ?, ?, ?)').run(name.trim(), role, pay_type, rate, gender);
  db.audit(actorId, 'employee.add', { id: r.lastInsertRowid, name, pay_type, rate });
  return byId(db, r.lastInsertRowid);
}
function setRate(db, empId, rate, actorId) {
  const before = byId(db, empId);
  db.prepare('UPDATE employees SET rate = ? WHERE id = ?').run(rate, empId);
  db.audit(actorId, 'employee.rate', { empId, from: before && before.rate, to: rate });
}
function setRole(db, empId, role, actorId) {
  db.prepare('UPDATE employees SET role = ? WHERE id = ?').run(role, empId);
  db.audit(actorId, 'employee.role', { empId, role });
}
function setActive(db, empId, active, actorId) {
  db.prepare('UPDATE employees SET active = ? WHERE id = ?').run(active ? 1 : 0, empId);
  db.audit(actorId, 'employee.active', { empId, active });
}

const payText = (e) => (e.pay_type === 'daily' ? `${e.rate} грн/день` : e.pay_type === 'monthly' ? `${e.rate} грн/міс` : '0 грн');
const roleText = (e) => (e.role === 'owner' ? 'власник' : e.role === 'admin' ? 'адміністратор' : 'працівник');
const came = (e) => (e.gender === 'm' ? 'Прийшов' : 'Прийшла');
const left = (e) => (e.gender === 'm' ? 'Пішов' : 'Пішла');

module.exports = { isAdmin, isOwner, list, byId, byTelegram, owner, admins, link, unlink, makeLinkCode, redeemCode, add, setRate, setRole, setActive, payText, roleText, came, left };
