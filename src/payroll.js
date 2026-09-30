'use strict';
const T = require('./time');

/**
 * Правила (ТЗ 30.09.2026):
 *  - hourly: ставка за годину, рахується до хвилини за фактичною тривалістю змін
 *    (відкрита зміна рахується до поточного моменту);
 *  - daily: 1 день = одна ставка, скільки б змін не було (залишено для сумісності);
 *  - monthly: повна місячна ставка за кожен місяць від місяця найму;
 *  - none (власник / адміністратор): 0 і не входить у підсумки.
 */
const round2 = (n) => Math.round(n * 100) / 100;

function shiftMinutes(s, now = new Date()) {
  const end = s.ended_at ? new Date(s.ended_at) : now;
  return Math.max(0, Math.round((end - new Date(s.started_at)) / 60000));
}
function minutesMonth(db, empId, month, now = new Date()) {
  return db.prepare('SELECT * FROM shifts WHERE emp_id = ? AND date LIKE ?').all(empId, `${month}-%`).reduce((a, s) => a + shiftMinutes(s, now), 0);
}
function minutesAll(db, empId, now = new Date()) {
  return db.prepare('SELECT * FROM shifts WHERE emp_id = ?').all(empId).reduce((a, s) => a + shiftMinutes(s, now), 0);
}
function minutesOn(db, empId, date, now = new Date()) {
  return db.prepare('SELECT * FROM shifts WHERE emp_id = ? AND date = ?').all(empId, date).reduce((a, s) => a + shiftMinutes(s, now), 0);
}
function payFor(emp, minutes) { return emp.pay_type === 'hourly' ? round2((minutes / 60) * emp.rate) : 0; }

function paidDays(db, empId, month) {
  return db.prepare('SELECT COUNT(DISTINCT date) c FROM shifts WHERE emp_id = ? AND date LIKE ?').get(empId, `${month}-%`).c;
}
function paidDaysAll(db, empId) {
  return db.prepare('SELECT COUNT(DISTINCT date) c FROM shifts WHERE emp_id = ?').get(empId).c;
}
function hireMonth(db, emp) {
  const first = db.prepare('SELECT MIN(date) d FROM shifts WHERE emp_id = ?').get(emp.id).d;
  const created = T.parts(new Date(emp.created_at)).month;
  return first && first.slice(0, 7) < created ? first.slice(0, 7) : created;
}
function monthsBetween(a, b) {
  const [ay, am] = a.split('-').map(Number); const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am) + 1;
}

function accruedMonth(db, emp, month, now = new Date()) {
  if (emp.pay_type === 'hourly') return payFor(emp, minutesMonth(db, emp.id, month, now));
  if (emp.pay_type === 'daily') return paidDays(db, emp.id, month) * emp.rate;
  if (emp.pay_type === 'monthly') return month >= hireMonth(db, emp) ? emp.rate : 0;
  return 0;
}
function accruedAll(db, emp, nowMonth, now = new Date()) {
  if (emp.pay_type === 'hourly') return payFor(emp, minutesAll(db, emp.id, now));
  if (emp.pay_type === 'daily') return paidDaysAll(db, emp.id) * emp.rate;
  if (emp.pay_type === 'monthly') return Math.max(0, monthsBetween(hireMonth(db, emp), nowMonth)) * emp.rate;
  return 0;
}
function ledgerSum(db, empId, type, month = null) {
  return month
    ? db.prepare('SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE emp_id = ? AND type = ? AND substr(created_at,1,7) = ?').get(empId, type, month).s
    : db.prepare('SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE emp_id = ? AND type = ?').get(empId, type).s;
}

/** Зведення по працівнику: місяць + загальний залишок. */
function summary(db, emp, month, nowMonth = month, now = new Date()) {
  const accrued = accruedMonth(db, emp, month, now);
  const advances = ledgerSum(db, emp.id, 'advance', month);
  const payouts = ledgerSum(db, emp.id, 'payout', month);
  const totalAccrued = accruedAll(db, emp, nowMonth, now);
  const totalPaid = ledgerSum(db, emp.id, 'advance') + ledgerSum(db, emp.id, 'payout');
  const minutes = emp.pay_type === 'hourly' ? minutesMonth(db, emp.id, month, now) : null;
  return {
    month,
    days: emp.pay_type === 'daily' ? paidDays(db, emp.id, month) : null,
    minutes, hours: minutes == null ? null : T.hoursText(minutes),
    accrued, advances, payouts, paid: advances + payouts,
    totalAccrued, totalPaid, balance: round2(totalAccrued - totalPaid),
  };
}

/** Аванс / виплата. idem_key захищає від подвійного натискання. */
function addLedger(db, { emp_id, type, amount, comment, admin_id, idem_key }) {
  if (!['advance', 'payout'].includes(type)) throw new Error('bad type');
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: 'Сума має бути цілим додатним числом' };
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(emp_id);
  if (!emp) return { ok: false, reason: 'Працівника не знайдено' };
  if (emp.pay_type === 'none') return { ok: false, reason: 'У цієї людини зарплата не ведеться — аванси та виплати неможливі' };
  try {
    const r = db.prepare('INSERT INTO ledger (emp_id, type, amount, comment, admin_id, idem_key) VALUES (?, ?, ?, ?, ?, ?)')
      .run(emp_id, type, amount, comment || null, admin_id || null, idem_key || null);
    db.audit(admin_id, `ledger.${type}`, { id: r.lastInsertRowid, emp_id, amount, comment });
    return { ok: true, id: r.lastInsertRowid, dup: false };
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return { ok: true, dup: true };
    throw e;
  }
}
function history(db, empId, n = 30) {
  return db.prepare('SELECT l.*, a.name admin_name FROM ledger l LEFT JOIN employees a ON a.id = l.admin_id WHERE l.emp_id = ? ORDER BY l.created_at DESC, l.id DESC LIMIT ?').all(empId, n);
}
function ledgerLine(l) {
  const t = l.type === 'advance' ? 'аванс' : 'виплата';
  return `${T.uaDateTime(l.created_at)} · ${t} ${T.money(l.amount)}${l.comment ? ' · ' + l.comment : ''}${l.admin_name ? ' · ' + l.admin_name : ''}`;
}

/** Місячний звіт по всіх, у кого ведеться зарплата. */
function monthlyReport(db, month, nowMonth = month, now = new Date()) {
  const emps = db.prepare("SELECT * FROM employees WHERE active = 1 AND pay_type <> 'none' ORDER BY id").all();
  const rows = emps.map((e) => ({ emp: e, ...summary(db, e, month, nowMonth, now) }));
  const total = rows.reduce((a, r) => ({
    minutes: a.minutes + (r.minutes || 0), accrued: round2(a.accrued + r.accrued), advances: a.advances + r.advances, payouts: a.payouts + r.payouts, balance: round2(a.balance + r.balance),
  }), { minutes: 0, accrued: 0, advances: 0, payouts: 0, balance: 0 });
  return { month, rows, total };
}
/** За день: хвилини та нараховано по кожному, хто працював. */
function dayStats(db, date, now = new Date()) {
  const emps = db.prepare("SELECT * FROM employees WHERE active = 1 AND pay_type <> 'none' ORDER BY id").all();
  const rows = emps.map((e) => { const minutes = minutesOn(db, e.id, date, now); return { emp: e, minutes, accrued: e.pay_type === 'hourly' ? payFor(e, minutes) : (e.pay_type === 'daily' && minutes > 0 ? e.rate : 0) }; }).filter((r) => r.minutes > 0);
  return { rows, minutes: rows.reduce((a, r) => a + r.minutes, 0), accrued: round2(rows.reduce((a, r) => a + r.accrued, 0)) };
}
function dayAccrued(db, date, now = new Date()) { return dayStats(db, date, now).accrued; }

module.exports = { round2, shiftMinutes, minutesMonth, minutesOn, payFor, paidDays, accruedMonth, accruedAll, summary, addLedger, history, ledgerLine, monthlyReport, dayStats, dayAccrued, hireMonth };
