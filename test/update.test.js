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
const { createUpdater } = require('../src/updater');
const { createScheduler } = require('../src/scheduler');
const { monthWorkbook, monthXlsx } = require('../src/export');

const at = (date, time) => new Date(T.kyivToIso(date, time));

/** git-заглушка: HEAD і origin/main задаються тестом. */
function fakeGit(state) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const a = args.join(' ');
    if (cmd === 'git' && a.startsWith('log -1')) return `${state.head.slice(0, 7)}|2026-09-30|latest commit`;
    if (cmd === 'git' && a.startsWith('fetch')) { if (state.offline) throw Object.assign(new Error('fetch'), { stderr: 'fatal: unable to access' }); return ''; }
    if (cmd === 'git' && a === 'rev-parse HEAD') return state.head;
    if (cmd === 'git' && a === 'rev-parse origin/main') return state.remote;
    if (cmd === 'git' && a.startsWith('log --oneline')) return state.changes.join('\n');
    if (cmd === 'git' && a.startsWith('pull')) { state.head = state.remote; if (state.newLock) fs.writeFileSync(path.join(state.root, 'package-lock.json'), state.newLock); return ''; }
    if (/npm/.test(cmd)) return 'installed';
    throw new Error('unexpected ' + cmd + ' ' + a);
  };
  return { exec, calls };
}
function gitRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ln9up-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'package-lock.json'), 'lock-v1');
  return root;
}

test('updater: version, check behind/up-to-date, apply pulls and installs deps only when the lock changed', async () => {
  const root = gitRoot();
  const state = { root, head: 'aaaaaaa111', remote: 'bbbbbbb222', changes: ['bbbbbbb fix late alert', 'ccccccc excel export'], newLock: null };
  const g = fakeGit(state);
  const u = createUpdater({ exec: g.exec, root, log: { log() {} } });
  assert.strictEqual((await u.version()).text, 'aaaaaaa · 2026-09-30');
  const c = await u.check();
  assert.deepStrictEqual([c.ok, c.behind, c.local, c.remote, c.changes.length], [true, true, 'aaaaaaa', 'bbbbbbb', 2]);
  const r = await u.apply();
  assert.deepStrictEqual([r.ok, r.updated, r.from, r.deps], [true, true, 'aaaaaaa', false]);
  assert.ok(!g.calls.some((c) => /npm/.test(c[0])));
  assert.strictEqual((await u.check()).behind, false);
  assert.strictEqual((await u.apply()).updated, false);
  // lock changes → npm install
  state.remote = 'ddddddd333'; state.newLock = 'lock-v2';
  const r2 = await u.apply();
  assert.deepStrictEqual([r2.ok, r2.deps], [true, true]);
  assert.ok(g.calls.some((c) => /npm/.test(c[0]) && c.includes('install')));
  // offline → honest failure, no crash
  state.offline = true;
  const c3 = await u.check();
  assert.strictEqual(c3.ok, false); assert.match(c3.reason, /unable to access/);
  const noGit = createUpdater({ exec: g.exec, root: os.tmpdir() });
  assert.strictEqual((await noGit.check()).ok, false);
});

function harness() {
  const db = open(':memory:');
  E.link(db, 4, 1000, null); E.link(db, 1, 2001, null);
  db.setting('admin_chat_id', '-5');
  const sent = [];
  const api = { sendMessage: async (chat_id, text) => { sent.push({ chat_id, text }); return { message_id: sent.length }; }, sendDocument: async () => ({ message_id: 1 }) };
  const { createNotifier } = require('../src/notify');
  const notify = createNotifier({ api, db });
  return { db, sent, notify, api };
}

test('scheduler: late-check-in alert once per day, toggle, weekend window', async () => {
  const h = harness();
  const sch = createScheduler({ db: h.db, notify: h.notify, api: h.api });
  let r = await sch.tick(at('2026-09-21', '08:59')); // Monday, gym opens 08:00, alert at 09:00
  assert.strictEqual(r.late, false);
  r = await sch.tick(at('2026-09-21', '09:00'));
  assert.strictEqual(r.late, true);
  assert.match(h.sent[h.sent.length - 1].text, /ще не відмітились: Юлія, Ірина/);
  r = await sch.tick(at('2026-09-21', '09:30'));
  assert.strictEqual(r.late, false); // once
  // Sunday opens 09:00 → 10:00; Юлія checked in → only Ірина
  S.start(h.db, E.byId(h.db, 1), at('2026-09-27', '09:10'));
  r = await sch.tick(at('2026-09-27', '10:00'));
  assert.strictEqual(r.late, true);
  assert.match(h.sent[h.sent.length - 1].text, /не відмітились: Ірина$/);
  h.db.setting('late_alert', '0');
  r = await sch.tick(at('2026-09-28', '10:00'));
  assert.strictEqual(r.late, false);
});

test('scheduler: reminder one hour before auto-close, once per shift, then auto-close', async () => {
  const h = harness();
  const sch = createScheduler({ db: h.db, notify: h.notify, api: h.api });
  S.start(h.db, E.byId(h.db, 1), at('2026-09-21', '08:00'));
  let r = await sch.tick(at('2026-09-21', '16:59'));
  assert.strictEqual(r.reminded.length, 0);
  r = await sch.tick(at('2026-09-21', '17:00'));
  assert.strictEqual(r.reminded.length, 1);
  const dm = h.sent.find((s) => s.chat_id === 2001);
  assert.match(dm.text, /Ви на зміні з 08:00[\s\S]*🔴 Пішла/);
  r = await sch.tick(at('2026-09-21', '17:30'));
  assert.strictEqual(r.reminded.length, 0);
  r = await sch.tick(at('2026-09-21', '18:00'));
  assert.strictEqual(r.closed.length, 1);
  assert.strictEqual(h.sent.filter((s) => s.chat_id === 2001).length, 1);
});

test('scheduler: update tick applies an update, notifies the group and restarts', async () => {
  const h = harness();
  const root = gitRoot();
  const state = { root, head: 'aaaaaaa111', remote: 'bbbbbbb222', changes: ['bbbbbbb better menu'] };
  const g = fakeGit(state);
  const updater = createUpdater({ exec: g.exec, root, log: { log() {} } });
  let restarted = 0;
  const sch = createScheduler({ db: h.db, notify: h.notify, api: h.api, updater, restart: () => { restarted++; }, updateEveryMin: 10 });
  let r = await sch.tick(at('2026-09-21', '12:00'));
  assert.strictEqual(r.updated, true);
  assert.match(h.sent[h.sent.length - 1].text, /Бот оновлено aaaaaaa → bbbbbbb[\s\S]*better menu/);
  await new Promise((res) => setTimeout(res, 900));
  assert.strictEqual(restarted, 1);
  // within 10 minutes: no re-check; after: up to date
  r = await sch.tick(at('2026-09-21', '12:05'));
  assert.strictEqual(r.updated, false);
  r = await sch.tick(at('2026-09-21', '12:11'));
  assert.strictEqual(r.updated, false);
});

test('export: monthly workbook has four sheets with the right numbers', () => {
  const h = harness();
  const yu = E.byId(h.db, 1);
  S.start(h.db, yu, at('2026-09-01', '09:00')); S.end(h.db, yu, at('2026-09-01', '15:00'));
  S.start(h.db, yu, at('2026-09-02', '09:00')); S.end(h.db, yu, at('2026-09-02', '19:30'));
  P.addLedger(h.db, { emp_id: yu.id, type: 'advance', amount: 700, comment: 'на ліки', admin_id: 4, idem_key: 'x' });
  const XLSX = require('xlsx');
  const wb = monthWorkbook(h.db, '2026-09');
  assert.deepStrictEqual(wb.SheetNames, ['Підсумок', 'Зміни', 'Аванси і виплати', 'Звіти каси']);
  const sum = XLSX.utils.sheet_to_json(wb.Sheets['Підсумок'], { header: 1 });
  assert.deepStrictEqual(sum[1], ['Юлія', '1400 грн/день', 2, 2800, 700, 0, 2100]);
  assert.deepStrictEqual(sum[sum.length - 1].slice(0, 4), ['Разом', '', '', 2800 + 12000]);
  const sh = XLSX.utils.sheet_to_json(wb.Sheets['Зміни'], { header: 1 });
  assert.deepStrictEqual(sh[2].slice(0, 5), ['02.09.2026', 'Юлія', '09:00', '19:30', '10 год 30 хв']);
  const led = XLSX.utils.sheet_to_json(wb.Sheets['Аванси і виплати'], { header: 1 });
  assert.deepStrictEqual(led[1].slice(1, 6), ['Юлія', 'аванс', 700, 'на ліки', 'Власник']);
  const f = monthXlsx(h.db, '2026-09');
  assert.strictEqual(f.name, 'LEVEL_NINE_2026-09.xlsx');
  assert.ok(f.buffer.length > 3000);
  const back = XLSX.read(f.buffer, { type: 'buffer' });
  assert.strictEqual(back.SheetNames.length, 4);
});
