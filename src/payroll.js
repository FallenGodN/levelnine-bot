'use strict';
const T = require('./time');

/**
 * Правила:
 *  - daily: 1 день = одна ставка, скільки б змін і годин не було цього дня;
 *  - monthly: повна місячна ставка за кожен місяць від місяця найму до поточного;
 *  - none (власник): 0 і не входить у підсумки.
 */
function paidDays(db, empId, month) {
  return db.prepare("SELECT COUNT(DISTINCT date) c FROM shifts WHERE emp_id = ? AND date LIKE ?").get(empId, `${month}-%`).c;
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

function accruedMonth(db, emp, month) {
  if (emp.pay_type === 'daily') return paidDays(db, emp.id, month) * emp.rate;
  if (emp.pay_type === 'monthly') return month >= hireMonth(db, emp) ? emp.rate : 0;
  return 0;
}
function accruedAll(db, emp, nowMonth) {
  if (emp.pay_type === 'daily') return paidDaysAll(db, emp.id) * emp.rate;
  if (emp.pay_type === 'monthly') return Math.max(0, monthsBetween(hireMonth(db, emp), nowMonth)) * emp.rate;
  return 0;
}
function ledgerSum(db, empId, type, month = null) {
  return month
    ? db.prepare("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE emp_id = ? AND type = ? AND substr(created_at,1,7) = ?").get(empId, type, month).s
    : db.prepare('SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE emp_id = ? AND type = ?').get(empId, type).s;
}

/** Зведення по працівнику: місяць + загальний залишок. */
function summary(db, emp, month, nowMonth = month) {
  const accrued = accruedMonth(db, emp, month);
  const advances = ledgerSum(db, emp.id, 'advance', month);
  const payouts = ledgerSum(db, emp.id, 'payout', month);
  const totalAccrued = accruedAll(db, emp, nowMonth);
  const totalPaid = ledgerSum(db, emp.id, 'advance') + ledgerSum(db, emp.id, 'payout');
  return {
    month, days: emp.pay_type === 'daily' ? paidDays(db, emp.id, month) : null,
    accrued, advances, payouts, paid: advances + payouts,
    totalAccrued, totalPaid, balance: totalAccrued - totalPaid,
  };
}

/** Аванс / виплата. idem_key захищає від подвійного натискання. */
function addLedger(db, { emp_id, type, amount, comment, admin_id, idem_key }) {
  if (!['advance', 'payout'].includes(type)) throw new Error('bad type');
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: 'Сума має бути цілим додатним числом' };
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(emp_id);
  if (!emp) return { ok: false, reason: 'Працівника не знайдено' };
  if (emp.pay_type === 'none') return { ok: false, reason: 'Власник не має зарплати — аванси та виплати не ведуться' };
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
  return db.prepare('SELECT l.*, a.name admin_name FROM ledger l LEFT JOIN employees a ON a.id = l.admin_id WHERE l.emp_id = ? ORDER BY l.created_at DESC LIMIT ?').all(empId, n);
}
function ledgerLine(l) {
  const t = l.type === 'advance' ? 'аванс' : 'виплата';
  return `${T.uaDateTime(l.created_at)} · ${t} ${l.amount} грн${l.comment ? ' · ' + l.comment : ''}${l.admin_name ? ' · ' + l.admin_name : ''}`;
}

/** Місячний звіт по всіх, крім власника. */
function monthlyReport(db, month, nowMonth = month) {
  const emps = db.prepare("SELECT * FROM employees WHERE active = 1 AND pay_type <> 'none' ORDER BY id").all();
  const rows = emps.map((e) => ({ emp: e, ...summary(db, e, month, nowMonth) }));
  const total = rows.reduce((a, r) => ({ accrued: a.accrued + r.accrued, advances: a.advances + r.advances, payouts: a.payouts + r.payouts, balance: a.balance + r.balance }), { accrued: 0, advances: 0, payouts: 0, balance: 0 });
  return { month, rows, total };
}
/** Нараховано за день (тільки денні ставки). */
function dayAccrued(db, date) {
  return db.prepare("SELECT COALESCE(SUM(e.rate),0) s FROM employees e WHERE e.pay_type = 'daily' AND e.active = 1 AND EXISTS (SELECT 1 FROM shifts s WHERE s.emp_id = e.id AND s.date = ?)").get(date).s;
}

module.exports = { paidDays, accruedMonth, accruedAll, summary, addLedger, history, ledgerLine, monthlyReport, dayAccrued, hireMonth };
