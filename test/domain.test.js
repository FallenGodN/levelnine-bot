'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { open } = require('../src/db');
const T = require('../src/time');
const E = require('../src/employees');
const S = require('../src/shifts');
const P = require('../src/payroll');
const R = require('../src/reports');

function fresh() { return open(':memory:'); }
const byName = (db, n) => db.prepare('SELECT * FROM employees WHERE name = ?').get(n);
const at = (date, time) => new Date(T.kyivToIso(date, time));

test('seed: four accounts with the right rates', () => {
  const db = fresh();
  const list = E.list(db);
  assert.deepStrictEqual(list.map((e) => [e.name, e.pay_type, e.rate, e.role]), [
    ['Юлія', 'daily', 1400, 'employee'], ['Ірина', 'daily', 1400, 'employee'],
    ['Прибиральник', 'monthly', 12000, 'employee'], ['Власник', 'none', 0, 'owner'],
  ]);
});

test('OWNER_TELEGRAM_ID reassigns the owner account on start', () => {
  const config = require('../src/config');
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ln9own-'));
  const file = require('path').join(dir, 'o.sqlite');
  config.ownerTelegramId = 111; let db = open(file);
  assert.strictEqual(E.owner(db).telegram_id, 111); db.close();
  config.ownerTelegramId = 222; db = open(file);
  assert.strictEqual(E.owner(db).telegram_id, 222);
  assert.strictEqual(E.byTelegram(db, 111), null); db.close();
  E.link(open(file), 1, 333, null);
  config.ownerTelegramId = 333; db = open(file); // taken by Юлія → owner stays 222
  assert.strictEqual(E.owner(db).telegram_id, 222); db.close();
  config.ownerTelegramId = 0;
});

test('kyiv time: DST boundaries and parsing', () => {
  assert.strictEqual(T.parts(at('2026-07-01', '08:00')).time, '08:00');
  assert.strictEqual(T.parts(at('2026-01-15', '23:30')).date, '2026-01-15');
  assert.strictEqual(T.parseDate('21.09.2026'), '2026-09-21');
  assert.strictEqual(T.parseDate('2026-02-30'), null);
  assert.strictEqual(T.parseTime('8:05'), '08:05');
  assert.strictEqual(T.parseTime('25:00'), null);
  assert.strictEqual(T.addDays('2026-03-29', 1), '2026-03-30'); // DST day
  assert.strictEqual(T.addMonths('2026-12', 1), '2027-01');
});

test('schedule: outside-hours detection per weekday', () => {
  assert.strictEqual(S.outsideSchedule(at('2026-09-21', '07:59')), true);  // Monday before 08:00
  assert.strictEqual(S.outsideSchedule(at('2026-09-21', '08:00')), false);
  assert.strictEqual(S.outsideSchedule(at('2026-09-21', '22:01')), true);
  assert.strictEqual(S.outsideSchedule(at('2026-09-26', '18:30')), true);  // Saturday after 18:00
  assert.strictEqual(S.outsideSchedule(at('2026-09-27', '15:59')), false); // Sunday
  assert.strictEqual(S.outsideSchedule(at('2026-09-27', '16:01')), true);
});

test('shift: start, duplicate start, end, no end without start', () => {
  const db = fresh(); const yu = byName(db, 'Юлія');
  const r1 = S.start(db, yu, at('2026-09-21', '08:30'));
  assert.strictEqual(r1.dup, false); assert.strictEqual(r1.outside, false);
  const r2 = S.start(db, yu, at('2026-09-21', '08:31'));
  assert.strictEqual(r2.dup, true); assert.strictEqual(r2.shift.id, r1.shift.id);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM shifts').get().c, 1);
  const e1 = S.end(db, yu, at('2026-09-21', '17:00'));
  assert.strictEqual(e1.none, false); assert.strictEqual(e1.shift.auto_closed, 0);
  const e2 = S.end(db, yu, at('2026-09-21', '17:05'));
  assert.strictEqual(e2.none, true);
  assert.strictEqual(S.start(db, yu, at('2026-09-21', '06:00')).outside, true);
});

test('auto-close: exactly 10 h after start, once, marked, pay unchanged', () => {
  const db = fresh(); const yu = byName(db, 'Юлія'); const ir = byName(db, 'Ірина');
  S.start(db, yu, at('2026-09-21', '08:00'));
  S.start(db, ir, at('2026-09-21', '12:00'));
  assert.strictEqual(S.autoClose(db, at('2026-09-21', '17:59')).length, 0);
  const closed = S.autoClose(db, at('2026-09-21', '18:00'));
  assert.strictEqual(closed.length, 1); assert.strictEqual(closed[0].name, 'Юлія');
  assert.strictEqual(T.parts(new Date(closed[0].ended_at)).time, '18:00');
  assert.strictEqual(S.autoClose(db, at('2026-09-21', '18:30')).length, 0); // not twice
  assert.strictEqual(S.working(db).length, 1);
  const s = S.byId(db, closed[0].id);
  assert.strictEqual(s.auto_closed, 1);
  assert.strictEqual(P.accruedMonth(db, yu, '2026-09'), 1400);
  // second start the same day after auto-close: new shift, still one paid day
  S.start(db, yu, at('2026-09-21', '19:00'));
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM shifts WHERE emp_id = ?').get(yu.id).c, 2);
  assert.strictEqual(P.accruedMonth(db, yu, '2026-09'), 1400);
});

test('payroll: 1400 per day max, cleaner 12000/month, owner 0 and excluded', () => {
  const db = fresh(); const yu = byName(db, 'Юлія'); const cl = byName(db, 'Прибиральник'); const ow = byName(db, 'Власник');
  for (const d of ['2026-09-01', '2026-09-02', '2026-09-02', '2026-09-03']) {
    S.start(db, yu, at(d, '09:00')); S.end(db, yu, at(d, '15:00'));
  }
  // a shift crossing midnight counts for its start date only
  S.start(db, yu, at('2026-09-04', '20:00')); S.end(db, yu, at('2026-09-05', '01:00'));
  assert.strictEqual(P.paidDays(db, yu.id, '2026-09'), 4);
  assert.strictEqual(P.accruedMonth(db, yu, '2026-09'), 5600);
  assert.strictEqual(P.accruedMonth(db, cl, '2026-09'), 12000);
  assert.strictEqual(P.accruedMonth(db, ow, '2026-09'), 0);
  for (const d of ['2026-09-01', '2026-09-02']) { S.start(db, ow, at(d, '09:00')); S.end(db, ow, at(d, '15:00')); }
  const rep = P.monthlyReport(db, '2026-09');
  assert.deepStrictEqual(rep.rows.map((r) => r.emp.name), ['Юлія', 'Ірина', 'Прибиральник']);
  assert.strictEqual(rep.total.accrued, 5600 + 0 + 12000);
  assert.strictEqual(P.dayAccrued(db, '2026-09-02'), 1400);
  assert.strictEqual(P.dayAccrued(db, '2026-09-10'), 0);
});

test('ledger: advances, payouts, balance, owner refused, idempotent', () => {
  const db = fresh(); const yu = byName(db, 'Юлія'); const ow = byName(db, 'Власник'); const adm = ow;
  for (const d of ['2026-09-01', '2026-09-02', '2026-09-03']) { S.start(db, yu, at(d, '09:00')); S.end(db, yu, at(d, '15:00')); }
  const a = P.addLedger(db, { emp_id: yu.id, type: 'advance', amount: 1000, comment: 'на тиждень', admin_id: adm.id, idem_key: 'k1' });
  assert.deepStrictEqual([a.ok, a.dup], [true, false]);
  const again = P.addLedger(db, { emp_id: yu.id, type: 'advance', amount: 1000, comment: 'на тиждень', admin_id: adm.id, idem_key: 'k1' });
  assert.deepStrictEqual([again.ok, again.dup], [true, true]);
  P.addLedger(db, { emp_id: yu.id, type: 'payout', amount: 2000, admin_id: adm.id, idem_key: 'k2' });
  const s = P.summary(db, yu, '2026-09');
  assert.deepStrictEqual([s.days, s.accrued, s.advances, s.payouts, s.balance], [3, 4200, 1000, 2000, 1200]);
  assert.strictEqual(P.history(db, yu.id).length, 2);
  assert.strictEqual(P.addLedger(db, { emp_id: ow.id, type: 'advance', amount: 100 }).ok, false);
  assert.strictEqual(P.addLedger(db, { emp_id: yu.id, type: 'advance', amount: -5 }).ok, false);
  assert.strictEqual(P.addLedger(db, { emp_id: yu.id, type: 'advance', amount: 10.5 }).ok, false);
});

test('cleaner: balance spans months, advances reduce it', () => {
  const db = fresh(); const cl = byName(db, 'Прибиральник');
  db.prepare("UPDATE employees SET created_at = '2026-08-10T00:00:00.000Z' WHERE id = ?").run(cl.id);
  const c = E.byId(db, cl.id);
  P.addLedger(db, { emp_id: c.id, type: 'payout', amount: 12000, idem_key: 'aug' });
  const s = P.summary(db, c, '2026-09', '2026-09');
  assert.deepStrictEqual([s.accrued, s.totalAccrued, s.totalPaid, s.balance], [12000, 24000, 12000, 12000]);
});

test('employees: link by id, link by code, uniqueness', () => {
  const db = fresh(); const yu = byName(db, 'Юлія'); const ir = byName(db, 'Ірина');
  assert.strictEqual(E.link(db, yu.id, 111, null).ok, true);
  assert.strictEqual(E.link(db, ir.id, 111, null).ok, false);
  const code = E.makeLinkCode(db, ir.id);
  assert.match(code, /^\d{6}$/);
  assert.strictEqual(E.redeemCode(db, '000000', 222).ok, false);
  const r = E.redeemCode(db, code, 222);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.emp.name, 'Ірина');
  assert.strictEqual(E.redeemCode(db, code, 333).ok, false); // one-time
  assert.strictEqual(E.byTelegram(db, 222).name, 'Ірина');
  assert.strictEqual(E.isAdmin(byName(db, 'Власник')), true);
  assert.strictEqual(E.isAdmin(yu), false);
});

test('shift edit and delete by admin', () => {
  const db = fresh(); const yu = byName(db, 'Юлія'); const adm = byName(db, 'Власник');
  const { shift } = S.start(db, yu, at('2026-09-21', '08:00'));
  const bad = S.edit(db, shift.id, { ended_at: T.kyivToIso('2026-09-21', '07:00') }, adm.id);
  assert.strictEqual(bad.ok, false);
  const ok = S.edit(db, shift.id, { ended_at: T.kyivToIso('2026-09-21', '16:00'), note: 'забула' }, adm.id);
  assert.strictEqual(ok.ok, true); assert.strictEqual(ok.shift.edited_by, adm.id);
  assert.match(S.line(ok.shift), /08:00–16:00 \(8 год 00 хв\) · виправлено/);
  const c = S.create(db, yu.id, T.kyivToIso('2026-09-20', '09:00'), T.kyivToIso('2026-09-20', '15:00'), adm.id);
  assert.strictEqual(c.ok, true); assert.strictEqual(c.shift.date, '2026-09-20');
  assert.strictEqual(S.remove(db, shift.id, adm.id).ok, true);
  assert.strictEqual(S.byId(db, shift.id), null);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM audit WHERE action LIKE 'shift.%'").get().c, 3);
});

test('reports: add, by date, recent', () => {
  const db = fresh();
  R.add(db, { date: '2026-09-21', kind: 'photo', file_id: 'F1', author: 'Власник', comment: 'вечір' });
  R.add(db, { date: '2026-09-20', kind: 'document', file_id: 'F2', file_name: 'kasa.xlsx', author: 'Власник' });
  assert.strictEqual(R.onDate(db, '2026-09-21').length, 1);
  assert.strictEqual(R.recent(db, 5)[0].file_id, 'F2');
  assert.strictEqual(R.between(db, '2026-09-01', '2026-09-30').length, 2);
  assert.match(R.line(R.byId(db, 1)), /📷 фото · Власник/);
});
