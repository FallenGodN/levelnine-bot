'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { open } = require('../src/db');
const T = require('../src/time');
const E = require('../src/employees');
const S = require('../src/shifts');
const P = require('../src/payroll');
const R = require('../src/reports');
const H = require('../src/help');

function fresh() { return open(':memory:'); }
const byName = (db, n) => db.prepare('SELECT * FROM employees WHERE name = ?').get(n);
const at = (date, time) => new Date(T.kyivToIso(date, time));
const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ln9-')), name);

test('seed: Юлія та Ірина по 100 грн/год, власник без зарплати', () => {
  const db = fresh();
  assert.deepStrictEqual(E.list(db).map((e) => [e.name, e.pay_type, e.rate, e.role]), [
    ['Юлія', 'hourly', 100, 'employee'], ['Ірина', 'hourly', 100, 'employee'], ['Власник', 'none', 0, 'owner'],
  ]);
});

test('migration: an old daily base becomes hourly, the cleaner is deactivated, new columns exist', () => {
  const file = tmpFile('m.sqlite');
  const Database = require('better-sqlite3');
  const raw = new Database(file);
  raw.exec(`CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'employee', pay_type TEXT NOT NULL DEFAULT 'daily', rate INTEGER NOT NULL DEFAULT 0, gender TEXT NOT NULL DEFAULT 'f', telegram_id INTEGER UNIQUE, active INTEGER NOT NULL DEFAULT 1, link_code TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    INSERT INTO employees (name, role, pay_type, rate, gender) VALUES ('Юлія','employee','daily',1400,'f'),('Ірина','employee','daily',1400,'f'),('Прибиральник','employee','monthly',12000,'m'),('Власник','owner','none',0,'m');
    CREATE TABLE reports (id INTEGER PRIMARY KEY, emp_id INTEGER, telegram_id INTEGER, author TEXT, date TEXT NOT NULL, kind TEXT NOT NULL, file_id TEXT, file_unique_id TEXT, file_name TEXT, mime TEXT, size INTEGER, local_path TEXT, comment TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    INSERT INTO reports (date, kind, file_id, author) VALUES ('2026-09-21','photo','F','Юлія');`);
  raw.close();
  const db = open(file);
  assert.deepStrictEqual(E.list(db).map((e) => [e.name, e.pay_type, e.rate]), [['Юлія', 'hourly', 100], ['Ірина', 'hourly', 100], ['Власник', 'none', 0]]);
  assert.strictEqual(E.list(db, { activeOnly: false }).find((e) => e.name === 'Прибиральник').active, 0);
  assert.deepStrictEqual([R.byId(db, 1).category, R.byId(db, 1).status], ['cash', 'new']);
  assert.strictEqual(db.setting('schema_v'), '2');
  db.close();
  const again = open(file);
  assert.strictEqual(E.list(again).length, 3); again.close();
});

test('kyiv time, money with kopecks, hours text', () => {
  assert.strictEqual(T.parts(at('2026-07-01', '08:00')).time, '08:00');
  assert.strictEqual(T.parseDate('21.09.2026'), '2026-09-21');
  assert.strictEqual(T.parseDate('2026-02-30'), null);
  assert.strictEqual(T.parseTime('8:05'), '08:05');
  assert.strictEqual(T.addDays('2026-03-29', 1), '2026-03-30');
  assert.strictEqual(T.money(1400), '1 400 грн');
  assert.strictEqual(T.money(1233.333), '1 233,33 грн');
  assert.strictEqual(T.money(-100), '-100 грн');
  assert.strictEqual(T.money(0.5), '0,50 грн');
  assert.strictEqual(T.hoursText(755), '12 год 35 хв');
  assert.strictEqual(T.hoursText(0), '0 год 00 хв');
});

test('OWNER_TELEGRAM_ID reassigns the owner; EXTRA_ADMINS creates admins without salary', () => {
  const config = require('../src/config');
  const file = tmpFile('o.sqlite');
  config.ownerTelegramId = 111; let db = open(file);
  assert.strictEqual(E.owner(db).telegram_id, 111); db.close();
  config.ownerTelegramId = 222; config.extraAdmins = [{ telegram_id: 947529523, name: 'Максим' }]; db = open(file);
  assert.strictEqual(E.owner(db).telegram_id, 222);
  assert.strictEqual(E.byTelegram(db, 111), null);
  const mx = E.byTelegram(db, 947529523);
  assert.deepStrictEqual([mx.name, mx.role, mx.pay_type], ['Максим', 'admin', 'none']);
  assert.doesNotMatch(JSON.stringify(P.monthlyReport(db, '2026-09').rows.map((r) => r.emp.name)), /Максим/);
  db.close(); config.ownerTelegramId = 0; config.extraAdmins = [];
});

test('shift: start, duplicate start, end, pay to the minute', () => {
  const db = fresh(); const yu = byName(db, 'Юлія');
  const r1 = S.start(db, yu, at('2026-09-21', '08:30'));
  assert.strictEqual(r1.dup, false);
  assert.strictEqual(S.start(db, yu, at('2026-09-21', '08:31')).dup, true);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM shifts').get().c, 1);
  assert.strictEqual(P.shiftMinutes(r1.shift, at('2026-09-21', '10:00')), 90);
  assert.strictEqual(P.payFor(yu, 90), 150);
  const e1 = S.end(db, yu, at('2026-09-21', '17:07'));
  assert.strictEqual(P.shiftMinutes(e1.shift), 517);
  assert.strictEqual(P.payFor(yu, 517), 861.67);
  assert.strictEqual(S.end(db, yu, at('2026-09-21', '17:08')).none, true);
  assert.strictEqual(S.start(db, yu, at('2026-09-21', '06:00')).outside, true);
});

test('auto-close at 22:20: not before, exactly at 22:20 of the start date, once; late start closes next day', () => {
  const db = fresh(); const yu = byName(db, 'Юлія'); const ir = byName(db, 'Ірина');
  S.start(db, yu, at('2026-09-21', '08:00'));
  S.start(db, ir, at('2026-09-21', '22:30'));
  assert.strictEqual(S.autoClose(db, at('2026-09-21', '22:19')).length, 0);
  const closed = S.autoClose(db, at('2026-09-21', '22:20'));
  assert.strictEqual(closed.length, 1); assert.strictEqual(closed[0].name, 'Юлія');
  assert.strictEqual(T.parts(new Date(closed[0].ended_at)).time, '22:20');
  assert.strictEqual(S.autoClose(db, at('2026-09-21', '23:00')).length, 0);
  assert.strictEqual(S.working(db).length, 1);
  const c2 = S.autoClose(db, at('2026-09-22', '22:20'));
  assert.strictEqual(c2.length, 1); assert.strictEqual(c2[0].name, 'Ірина');
  assert.strictEqual(T.parts(new Date(c2[0].ended_at)).date, '2026-09-22');
  const s = S.byId(db, closed[0].id);
  assert.strictEqual(s.auto_closed, 1);
  assert.strictEqual(P.shiftMinutes(s), 14 * 60 + 20);
  assert.strictEqual(P.accruedMonth(db, yu, '2026-09'), 1433.33);
});

test('payroll: month totals to the minute, owner excluded, day stats', () => {
  const db = fresh(); const yu = byName(db, 'Юлія'); const ir = byName(db, 'Ірина'); const ow = byName(db, 'Власник');
  S.start(db, yu, at('2026-09-01', '09:00')); S.end(db, yu, at('2026-09-01', '15:30'));
  S.start(db, yu, at('2026-09-02', '09:00')); S.end(db, yu, at('2026-09-02', '12:15'));
  S.start(db, yu, at('2026-09-02', '14:00')); S.end(db, yu, at('2026-09-02', '16:00'));
  S.start(db, ir, at('2026-09-04', '20:00')); S.end(db, ir, at('2026-09-05', '01:00'));
  S.start(db, ow, at('2026-09-01', '09:00')); S.end(db, ow, at('2026-09-01', '15:00'));
  assert.strictEqual(P.minutesMonth(db, yu.id, '2026-09'), 705);
  assert.strictEqual(P.accruedMonth(db, yu, '2026-09'), 1175);
  assert.strictEqual(P.accruedMonth(db, ir, '2026-09'), 500);
  assert.strictEqual(P.accruedMonth(db, ow, '2026-09'), 0);
  const rep = P.monthlyReport(db, '2026-09');
  assert.deepStrictEqual(rep.rows.map((r) => r.emp.name), ['Юлія', 'Ірина']);
  assert.deepStrictEqual([rep.total.minutes, rep.total.accrued], [1005, 1675]);
  const ds = P.dayStats(db, '2026-09-02');
  assert.deepStrictEqual([ds.rows.length, ds.minutes, ds.accrued], [1, 315, 525]);
  assert.strictEqual(P.dayAccrued(db, '2026-09-10'), 0);
  const s = P.summary(db, yu, '2026-09');
  assert.deepStrictEqual([s.hours, s.accrued, s.balance], ['11 год 45 хв', 1175, 1175]);
});

test('ledger: advances, payouts, balance, owner refused, idempotent', () => {
  const db = fresh(); const yu = byName(db, 'Юлія'); const ow = byName(db, 'Власник');
  S.start(db, yu, at('2026-09-01', '09:00')); S.end(db, yu, at('2026-09-01', '19:00'));
  const a = P.addLedger(db, { emp_id: yu.id, type: 'advance', amount: 300, comment: 'на тиждень', admin_id: ow.id, idem_key: 'k1' });
  assert.deepStrictEqual([a.ok, a.dup], [true, false]);
  assert.strictEqual(P.addLedger(db, { emp_id: yu.id, type: 'advance', amount: 300, admin_id: ow.id, idem_key: 'k1' }).dup, true);
  P.addLedger(db, { emp_id: yu.id, type: 'payout', amount: 500, admin_id: ow.id, idem_key: 'k2' });
  const s = P.summary(db, yu, '2026-09');
  assert.deepStrictEqual([s.accrued, s.advances, s.payouts, s.balance], [1000, 300, 500, 200]);
  assert.strictEqual(P.addLedger(db, { emp_id: ow.id, type: 'advance', amount: 100 }).ok, false);
  assert.strictEqual(P.addLedger(db, { emp_id: yu.id, type: 'advance', amount: 10.5 }).ok, false);
});

test('employees: link by id, link by code, uniqueness', () => {
  const db = fresh(); const yu = byName(db, 'Юлія'); const ir = byName(db, 'Ірина');
  assert.strictEqual(E.link(db, yu.id, 111, null).ok, true);
  assert.strictEqual(E.link(db, ir.id, 111, null).ok, false);
  const code = E.makeLinkCode(db, ir.id);
  assert.strictEqual(E.redeemCode(db, '000000', 222).ok, false);
  assert.strictEqual(E.redeemCode(db, code, 222).emp.name, 'Ірина');
  assert.strictEqual(E.redeemCode(db, code, 333).ok, false);
});

test('shift edit and delete by admin', () => {
  const db = fresh(); const yu = byName(db, 'Юлія'); const adm = byName(db, 'Власник');
  const { shift } = S.start(db, yu, at('2026-09-21', '08:00'));
  assert.strictEqual(S.edit(db, shift.id, { ended_at: T.kyivToIso('2026-09-21', '07:00') }, adm.id).ok, false);
  const ok = S.edit(db, shift.id, { ended_at: T.kyivToIso('2026-09-21', '16:00'), note: 'забула' }, adm.id);
  assert.match(S.line(ok.shift), /08:00–16:00 \(8 год 00 хв\) · виправлено/);
  assert.strictEqual(S.create(db, yu.id, T.kyivToIso('2026-09-20', '09:00'), T.kyivToIso('2026-09-20', '15:00'), adm.id).shift.date, '2026-09-20');
  assert.strictEqual(S.remove(db, shift.id, adm.id).ok, true);
  assert.strictEqual(S.byId(db, shift.id), null);
});

test('reports: categories, problems open/done, filters', () => {
  const db = fresh();
  R.add(db, { date: '2026-09-21', kind: 'photo', category: 'cash', file_id: 'F1', author: 'Юлія', comment: 'вечір' });
  R.add(db, { date: '2026-09-21', kind: 'video', category: 'problem', file_id: 'V1', author: 'Ірина', comment: 'тече кран' });
  R.add(db, { date: '2026-09-20', kind: 'photo', category: 'photo', file_id: 'F2', author: 'Юлія' });
  assert.strictEqual(R.onDate(db, '2026-09-21').length, 2);
  assert.strictEqual(R.onDate(db, '2026-09-21', 'cash').length, 1);
  assert.strictEqual(R.recent(db, 5, 'problem')[0].file_id, 'V1');
  assert.strictEqual(R.openProblems(db).length, 1);
  R.setStatus(db, 2, 'done');
  assert.strictEqual(R.openProblems(db).length, 0);
  assert.match(R.line(R.byId(db, 2)), /🚨 Проблема.*🎥 відео.*Ірина · ✅ вирішено/);
  assert.match(R.line(R.byId(db, 1)), /💵 Звіт каси.*📷 фото.*Юлія/);
});

test('help: sections, articles, media, edit, delete', () => {
  const db = fresh();
  const a = H.add(db, { section: 'Instasport', title: 'Як провести абонемент', body: 'Крок 1…', media: [{ kind: 'photo', file_id: 'P1' }] }, 4);
  H.add(db, { section: 'Level Nine', title: 'Відкриття зали', body: '' }, 4);
  assert.deepStrictEqual(H.sections(db).map((s) => [s.section, s.n]), [['Instasport', 1], ['Level Nine', 1]]);
  assert.strictEqual(H.list(db, 'Instasport')[0].title, 'Як провести абонемент');
  H.addMedia(db, a.id, { kind: 'video', file_id: 'V1' }, 4);
  assert.deepStrictEqual(H.media(H.byId(db, a.id)).map((m) => m.file_id), ['P1', 'V1']);
  H.setBody(db, a.id, 'Крок 1, крок 2', 4);
  assert.strictEqual(H.byId(db, a.id).body, 'Крок 1, крок 2');
  assert.strictEqual(H.search(db, 'абонемент').length, 1);
  H.remove(db, a.id, 4);
  assert.strictEqual(H.byId(db, a.id), null);
});
