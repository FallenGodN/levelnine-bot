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
const { createBot, B } = require('../src/bot');
const { createNotifier } = require('../src/notify');
const { createScheduler } = require('../src/scheduler');
const config = require('../src/config');

const OWNER = 1000, GROUP = -100500, YU = 2001, IR = 2002;
const at = (date, time) => new Date(T.kyivToIso(date, time));

async function harness({ group = true } = {}) {
  const db = open(':memory:');
  E.link(db, E.owner(db).id, OWNER, null);
  if (group) db.setting('admin_chat_id', String(GROUP));
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ln9-'));
  const deps = {};
  const bot = createBot({
    token: 'test', db, deps,
    botInfo: { id: 1, is_bot: true, first_name: 'T', username: 'test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false },
    download: async (fileId, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, `file:${fileId}`); return dest; },
  });
  const calls = [];
  const failing = new Set();
  let mid = 1;
  bot.api.config.use(async (prev, method, payload) => {
    calls.push({ method, payload });
    if (payload && failing.has(Number(payload.chat_id))) return { ok: false, error_code: 403, description: 'Forbidden: bot was blocked' };
    if (method.startsWith('send')) return { ok: true, result: { message_id: mid++, chat: { id: payload.chat_id, type: 'private' }, date: 0, text: payload.text } };
    if (method === 'getFile') return { ok: true, result: { file_id: payload.file_id, file_unique_id: 'u', file_path: 'photos/x.jpg' } };
    return { ok: true, result: true };
  });
  const notify = createNotifier({ api: bot.api, db });
  let clock = null;
  const scheduler = createScheduler({ db, notify, api: bot.api, now: () => clock || new Date() });
  Object.assign(deps, { notify, scheduler });

  let n = 100;
  const from = (id) => ({ id, is_bot: false, first_name: `U${id}` });
  const text = (uid, t, chat) => bot.handleUpdate({ update_id: n++, message: { message_id: n, date: 0, chat: chat || { id: uid, type: 'private' }, from: from(uid), text: t, entities: t.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: t.split(' ')[0].length }] : undefined } });
  const cb = (uid, data, chat) => bot.handleUpdate({ update_id: n++, callback_query: { id: `q${n}`, from: from(uid), chat_instance: 'ci', data, message: { message_id: n, date: 0, chat: chat || { id: uid, type: 'private' }, text: 'm' } } });
  const photo = (uid, caption) => bot.handleUpdate({ update_id: n++, message: { message_id: n, date: 0, chat: { id: uid, type: 'private' }, from: from(uid), caption, photo: [{ file_id: 'small', file_unique_id: 'us', width: 90, height: 90, file_size: 100 }, { file_id: `big${n}`, file_unique_id: `ub${n}`, width: 1280, height: 960, file_size: 200000 }] } });
  const video = (uid, caption) => bot.handleUpdate({ update_id: n++, message: { message_id: n, date: 0, chat: { id: uid, type: 'private' }, from: from(uid), caption, video: { file_id: `vid${n}`, file_unique_id: `uv${n}`, width: 1280, height: 720, duration: 5, mime_type: 'video/mp4', file_size: 500000 } } });
  const doc = (uid, file_name, mime_type, size = 5000) => bot.handleUpdate({ update_id: n++, message: { message_id: n, date: 0, chat: { id: uid, type: 'private' }, from: from(uid), document: { file_id: `doc${n}`, file_unique_id: `ud${n}`, file_name, mime_type, file_size: size } } });
  const sent = (chatId) => calls.filter((c) => c.method === 'sendMessage' && Number(c.payload.chat_id) === chatId).map((c) => c.payload);
  const last = (chatId) => { const s = sent(chatId); return s[s.length - 1]; };
  const lastText = (chatId) => (last(chatId) || {}).text || '';
  const kbTexts = (p) => JSON.stringify((p && p.reply_markup) || {});
  const answers = () => calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.payload.text || '');
  return { db, bot, calls, failing, text, cb, photo, video, doc, sent, last, lastText, kbTexts, answers, scheduler, notify, setClock: (d) => { clock = d; } };
}

test('unlinked user sees their ID; owner gets the admin menu without any AI button', async () => {
  const h = await harness();
  await h.text(5555, '/start');
  assert.match(h.lastText(5555), /Telegram ID: <code>5555<\/code>/);
  await h.text(OWNER, '/start');
  assert.match(h.lastText(OWNER), /Вітаю, Власник/);
  const kb = h.kbTexts(h.last(OWNER));
  for (const b of [B.panel, B.working, B.employees, B.history, B.payroll, B.advance, B.payout, B.fixShift, B.reports, B.monthly, B.cash, B.photo, B.problem, B.help, B.alarm, B.settings, '🟢 Прийшов']) assert.ok(kb.includes(b), `missing ${b}`);
  assert.doesNotMatch(kb, /AI/);
});

test('linking by code, attendance to the minute, owner + group notified, employee menu', async () => {
  const h = await harness();
  await h.text(OWNER, B.employees);
  await h.cb(OWNER, 'em:v:1');
  await h.cb(OWNER, 'em:code:1');
  const code = h.lastText(OWNER).match(/<code>(\d{6})<\/code>/)[1];
  await h.text(YU, code);
  assert.match(h.lastText(YU), /Ви — <b>Юлія<\/b>/);
  const kb = h.kbTexts(h.last(YU));
  for (const b of ['🟢 Прийшла', '🔴 Пішла', B.stats, B.salary, B.cash, B.photo, B.problem, B.help]) assert.ok(kb.includes(b), `missing ${b}`);
  assert.doesNotMatch(kb, /ТЕРМІНОВО|Панель/);
  assert.match(h.lastText(GROUP), /Юлія прив'язав/);
  assert.match(h.lastText(OWNER), /Юлія прив'язав/); // owner gets it too

  await h.text(YU, '🟢 Прийшла');
  assert.match(h.lastText(YU), /Прихід відмічено/);
  assert.match(h.lastText(GROUP), /🟢 <b>Юлія<\/b> прийшла/);
  assert.match(h.lastText(OWNER), /🟢 <b>Юлія<\/b> прийшла/);
  await h.text(YU, '🟢 Прийшла');
  assert.match(h.lastText(YU), /вже відкрита/);
  assert.strictEqual(h.db.prepare('SELECT COUNT(*) c FROM shifts').get().c, 1);
  // make the shift 2 h 30 min long, then close
  h.db.prepare('UPDATE shifts SET started_at = ?').run(new Date(Date.now() - 150 * 60000).toISOString());
  await h.text(YU, '🔴 Пішла');
  assert.match(h.lastText(YU), /Зміну закрито[\s\S]*2 год 30 хв · 250 грн/);
  assert.match(h.lastText(OWNER), /пішла[\s\S]*2 год 30 хв · 250 грн/);
  await h.text(YU, '💰 Моя зарплата');
  assert.match(h.lastText(YU), /Відпрацьовано: <b>2 год 30 хв<\/b>[\s\S]*Нараховано за місяць: <b>250 грн<\/b>/);
  await h.text(YU, '📊 Моя статистика');
  assert.match(h.lastText(YU), /Відпрацьовано: <b>2 год 30 хв<\/b> · 250 грн/);
});

test('advance flow: confirmation, double tap ignored, employee cannot use it', async () => {
  const h = await harness();
  E.link(h.db, 1, YU, null);
  await h.text(OWNER, B.advance);
  assert.match(h.kbTexts(h.last(OWNER)), /led:emp:1/);
  assert.doesNotMatch(h.kbTexts(h.last(OWNER)), /led:emp:3/); // the owner is not payable
  await h.cb(OWNER, 'led:emp:1');
  await h.text(OWNER, '1000');
  await h.text(OWNER, 'за тиждень');
  const nonce = h.kbTexts(h.last(OWNER)).match(/led:ok:([0-9a-f]+)/)[1];
  await h.cb(OWNER, `led:ok:${nonce}`);
  assert.match(h.lastText(OWNER), /Аванс <b>1 000 грн<\/b> для <b>Юлія<\/b> записано/);
  assert.match(h.lastText(GROUP), /➕ Аванс 1 000 грн — Юлія \(за тиждень\)/);
  await h.cb(OWNER, `led:ok:${nonce}`);
  assert.strictEqual(h.db.prepare('SELECT COUNT(*) c FROM ledger').get().c, 1);
  assert.ok(h.answers().some((t) => /вже виконано/.test(t)));
  await h.text(YU, B.advance);
  assert.match(h.lastText(YU), /Оберіть дію/);
  await h.text(YU, B.salary);
  assert.match(h.lastText(YU), /Аванси за місяць: 1 000 грн[\s\S]*Залишок до виплати: -1 000 грн/);
});

test('reports: photo defaults to фото-звіт, cash flow, video problem, reclassify, list, done, owner gets media', async () => {
  const h = await harness();
  E.link(h.db, 1, YU, null);
  // plain photo → фото-звіт
  await h.photo(YU, 'вітрина');
  const saved = h.sent(YU)[h.sent(YU).length - 2];
  assert.match(saved.text, /📷 Фото-звіт <b>#1<\/b> збережено[\s\S]*вітрина/);
  assert.match(h.kbTexts(saved), /rp:cat:1:cash[\s\S]*rp:cat:1:problem/);
  assert.match(h.lastText(OWNER), /📷 Фото-звіт #1 від Юлія/);
  assert.ok(h.calls.some((c) => c.method === 'sendPhoto' && Number(c.payload.chat_id) === OWNER));
  assert.ok(h.calls.some((c) => c.method === 'sendPhoto' && Number(c.payload.chat_id) === GROUP));
  // cash flow
  await h.text(YU, B.cash);
  await h.photo(YU);
  assert.strictEqual(R.byId(h.db, 2).category, 'cash');
  assert.match(h.lastText(GROUP), /💵 Звіт каси #2 від Юлія/);
  assert.match(h.lastText(YU), /Звіт каси передано власнику/);
  // problem with description + video
  await h.text(YU, B.problem);
  assert.match(h.lastText(YU), /Опишіть проблему/);
  await h.text(YU, 'Тече кран у душі');
  await h.video(YU);
  const pr = R.byId(h.db, 3);
  assert.deepStrictEqual([pr.category, pr.kind, pr.comment, pr.status], ['problem', 'video', 'Тече кран у душі', 'new']);
  assert.match(h.lastText(OWNER), /🚨 <b>ПРОБЛЕМА #3<\/b> від Юлія[\s\S]*Тече кран/);
  assert.ok(h.calls.some((c) => c.method === 'sendVideo' && Number(c.payload.chat_id) === OWNER));
  // problem without media
  await h.text(YU, B.problem); await h.text(YU, 'Немає паперу'); await h.text(YU, B.done);
  assert.deepStrictEqual([R.byId(h.db, 4).category, R.byId(h.db, 4).kind], ['problem', 'text']);
  // reclassify #1 as cash
  await h.cb(YU, 'rp:cat:1:cash');
  assert.strictEqual(R.byId(h.db, 1).category, 'cash');
  // admin views + resolves
  await h.text(OWNER, B.reports);
  assert.match(h.kbTexts(h.last(OWNER)), /rv:problems/);
  await h.cb(OWNER, 'rv:problems');
  assert.match(h.sent(OWNER).map((p) => p.text).join('\n'), /Відкриті проблеми<\/b> — 2/);
  assert.ok(h.calls.some((c) => c.method === 'sendVideo' && Number(c.payload.chat_id) === OWNER && /rp:done:3/.test(JSON.stringify(c.payload.reply_markup))));
  await h.cb(OWNER, 'rp:done:3');
  assert.strictEqual(R.byId(h.db, 3).status, 'done');
  assert.strictEqual(R.openProblems(h.db).length, 1);
  // employee cannot resolve
  await h.cb(YU, 'rp:done:4');
  assert.strictEqual(R.byId(h.db, 4).status, 'new');
  // by date
  await h.cb(OWNER, 'rv:date:all'); await h.text(OWNER, '01.01.2020');
  assert.match(h.lastText(OWNER), /нічого немає/);
  // oversized document keeps only the link
  await h.doc(OWNER, 'huge.pdf', 'application/pdf', 30 * 1024 * 1024);
  assert.strictEqual(R.byId(h.db, 5).local_path, null);
});

test('help base: empty for employee, admin adds an article with photos, employee reads it, edit and delete', async () => {
  const h = await harness();
  E.link(h.db, 1, YU, null);
  await h.text(YU, B.help);
  assert.match(h.lastText(YU), /Інструкцій ще немає/);
  assert.doesNotMatch(h.kbTexts(h.last(YU)), /hp:add/);
  await h.text(OWNER, B.help);
  assert.match(h.kbTexts(h.last(OWNER)), /hp:add/);
  await h.cb(OWNER, 'hp:add');
  await h.text(OWNER, 'Instasport');
  await h.text(OWNER, 'Як продати абонемент');
  await h.text(OWNER, 'Крок 1: відкрити клієнта. Крок 2: Продати.');
  await h.photo(OWNER); await h.photo(OWNER);
  assert.match(h.lastText(OWNER), /Додано \(2\)/);
  await h.text(OWNER, B.done);
  const H = require('../src/help');
  const art = H.list(h.db, 'Instasport')[0];
  assert.strictEqual(art.title, 'Як продати абонемент');
  assert.strictEqual(H.media(H.byId(h.db, art.id)).length, 2);
  assert.strictEqual(h.db.prepare('SELECT COUNT(*) c FROM reports').get().c, 0); // photos went to the article, not to reports
  // employee reads
  await h.text(YU, B.help);
  assert.match(h.kbTexts(h.last(YU)), /Instasport \(1\)/);
  await h.cb(YU, 'hp:sec:Instasport');
  await h.cb(YU, `hp:art:${art.id}`);
  assert.match(h.lastText(YU), /Як продати абонемент[\s\S]*Крок 1/);
  assert.strictEqual(h.calls.filter((c) => c.method === 'sendPhoto' && Number(c.payload.chat_id) === YU).length, 2);
  assert.doesNotMatch(h.kbTexts(h.last(YU)), /hp:edit/);
  // admin edits text, adds media, deletes
  await h.cb(OWNER, `hp:edit:${art.id}`); await h.text(OWNER, 'Новий текст');
  assert.strictEqual(H.byId(h.db, art.id).body, 'Новий текст');
  await h.cb(OWNER, `hp:media:${art.id}`); await h.video(OWNER); await h.text(OWNER, B.done);
  assert.strictEqual(H.media(H.byId(h.db, art.id)).length, 3);
  await h.cb(OWNER, `hp:del:${art.id}`); await h.cb(OWNER, `hp:delok:${art.id}`);
  assert.strictEqual(H.byId(h.db, art.id), null);
});

test('owner panel shows live hours, pay, month totals, reports and open problems', async () => {
  const h = await harness();
  E.link(h.db, 1, YU, null);
  const yu = E.byId(h.db, 1);
  S.start(h.db, yu, new Date(Date.now() - 90 * 60000)); // 1 h 30 on shift now
  const ir = E.byId(h.db, 2);
  const d = T.parts().date;
  S.start(h.db, ir, at(d, '00:10')); S.end(h.db, ir, at(d, '02:10')); // 2 h today
  R.add(h.db, { date: d, kind: 'photo', category: 'cash', author: 'Ірина' });
  R.add(h.db, { date: d, kind: 'text', category: 'problem', author: 'Ірина', comment: 'зламався замок' });
  await h.text(OWNER, B.panel);
  const t = h.lastText(OWNER);
  assert.match(t, /Панель власника/);
  assert.match(t, /Зараз працюють:<\/b>\n• Юлія — з \d\d:\d\d · 1 год 30 хв · 150 грн/);
  assert.match(t, /Сьогодні:<\/b>\n[\s\S]*Ірина — 2 год 00 хв · 200 грн/);
  assert.match(t, /Юлія — 1 год 30 хв · нараховано 150 грн/);
  assert.match(t, /Звіти сьогодні:<\/b> каса 1 · фото 0/);
  assert.match(t, /Відкриті проблеми:<\/b> 1\n• #2 · 🚨 Проблема[\s\S]*зламався замок/);
  assert.match(h.kbTexts(h.last(OWNER)), /rv:problems/);
  await h.text(OWNER, B.working);
  assert.match(h.lastText(OWNER), /Юлія — з \d\d:\d\d · 1 год 30 хв · 150 грн/);
});

test('alarm: confirmation, delivery reported honestly, failures not hidden', async () => {
  const h = await harness();
  E.link(h.db, 2, IR, null); E.setRole(h.db, 2, 'admin', null);
  await h.text(IR, B.alarm);
  await h.cb(IR, 'al:yes');
  await h.text(IR, 'Прорвало трубу в залі');
  assert.match(h.lastText(OWNER), /🚨🚨🚨 <b>ТЕРМІНОВО<\/b>\nВід: <b>Ірина<\/b>[\s\S]*Прорвало трубу/);
  assert.match(h.lastText(IR), /✅ Доставлено власнику\n✅ Доставлено в адмін-чат/);
  h.failing.add(GROUP);
  await h.text(IR, B.alarm); await h.cb(IR, 'al:yes'); await h.text(IR, B.noText);
  assert.match(h.lastText(IR), /✅ Доставлено власнику\n❌ В адмін-чат НЕ доставлено/);
  E.link(h.db, 1, YU, null);
  await h.text(YU, B.alarm);
  assert.strictEqual(h.bot.flows.size, 0);
});

test('without a group everything still reaches the owner; daily report once', async () => {
  const h = await harness({ group: false });
  E.link(h.db, 1, YU, null);
  await h.text(YU, '🟢 Прийшла');
  assert.match(h.lastText(OWNER), /🟢 <b>Юлія<\/b> прийшла/);
  assert.strictEqual(h.sent(GROUP).length, 0);
  h.setClock(at('2026-09-21', '22:30'));
  let r = await h.scheduler.tick(at('2026-09-21', '22:30'));
  assert.strictEqual(r.daily, true);
  assert.match(h.lastText(OWNER), /Підсумок дня 21.09.2026/);
  r = await h.scheduler.tick(at('2026-09-21', '23:10'));
  assert.strictEqual(r.daily, false);
});

test('fix shift: change end time, add a shift manually, delete with confirmation', async () => {
  const h = await harness();
  const yu = E.byId(h.db, 1);
  const { shift } = S.start(h.db, yu, at('2026-09-21', '08:00'));
  await h.text(OWNER, B.fixShift);
  await h.cb(OWNER, 'fx:emp:1');
  await h.cb(OWNER, `fx:s:${shift.id}`);
  await h.cb(OWNER, `fx:en:${shift.id}`);
  await h.text(OWNER, '16:00');
  assert.match(h.lastText(OWNER), /Зміну виправлено: Юлія 21.09.2026 08:00–16:00/);
  assert.match(h.lastText(GROUP), /виправив\(ла\) зміну Юлія/);
  await h.cb(OWNER, 'fx:new:1');
  await h.text(OWNER, '20.09.2026'); await h.text(OWNER, '09:00'); await h.text(OWNER, '15:30');
  assert.match(h.lastText(OWNER), /Зміну додано: Юлія 20.09.2026 09:00–15:30/);
  await h.cb(OWNER, `fx:del:${shift.id}`);
  await h.cb(OWNER, `fx:delok:${shift.id}`);
  assert.strictEqual(h.db.prepare('SELECT COUNT(*) c FROM shifts').get().c, 1);
});

test('admin group via /chatid, settings, employees (hourly add, rate change owner-only), monthly + Excel', async () => {
  const h = await harness();
  h.db.setting('admin_chat_id', null);
  const g = { id: -777, type: 'supergroup' };
  await h.text(OWNER, '/chatid', g);
  await h.cb(OWNER, 'st:group:-777', g);
  assert.strictEqual(h.notify.groupId(), -777);
  await h.text(OWNER, B.settings);
  assert.match(h.lastText(OWNER), /Автозакриття зміни: о 22:20 · нагадування працівнику о 21:50/);
  assert.doesNotMatch(h.lastText(OWNER), /AI/);
  await h.cb(OWNER, 'st:time'); await h.text(OWNER, '21:15');
  assert.strictEqual(h.scheduler.reportTime(), '21:15');
  await h.cb(OWNER, 'em:add'); await h.text(OWNER, 'Олена'); await h.cb(OWNER, 'em:pt:hourly'); await h.text(OWNER, '120'); await h.cb(OWNER, 'em:g:f');
  const ol = h.db.prepare("SELECT * FROM employees WHERE name = 'Олена'").get();
  assert.deepStrictEqual([ol.pay_type, ol.rate], ['hourly', 120]);
  await h.cb(OWNER, 'em:rate:1'); await h.text(OWNER, '110');
  const nonce = h.kbTexts(h.last(OWNER)).match(/em:rateok:1:([0-9a-f]+)/)[1];
  await h.cb(OWNER, `em:rateok:1:${nonce}`);
  assert.strictEqual(E.byId(h.db, 1).rate, 110);
  E.link(h.db, 2, IR, null); E.setRole(h.db, 2, 'admin', null);
  await h.cb(IR, 'em:rate:1');
  assert.ok(h.answers().some((t) => /лише власник/.test(t)));
  await h.text(OWNER, B.monthly);
  assert.match(h.lastText(OWNER), /Місячний звіт[\s\S]*Разом:<\/b> 0 год 00 хв/);
  await h.cb(OWNER, `mr:x:${T.parts().month}`);
  assert.ok(h.calls.some((c) => c.method === 'sendDocument' && Number(c.payload.chat_id) === OWNER));
});

test('settings: version and update button', async () => {
  const h = await harness();
  let applied = 0, restarted = 0;
  h.bot.deps.updater = {
    version: async () => ({ hash: 'abc1234', date: '2026-09-30', subject: 'hourly pay', text: 'abc1234 · 2026-09-30' }),
    check: async () => (applied ? { ok: true, behind: false, local: 'def5678' } : { ok: true, behind: true, local: 'abc1234', remote: 'def5678', changes: ['def5678 hourly pay'] }),
    apply: async () => { applied++; return { ok: true, updated: true, from: 'abc1234', to: 'def5678', deps: false }; },
  };
  h.bot.deps.restart = () => { restarted++; };
  await h.text(OWNER, B.settings);
  assert.match(h.lastText(OWNER), /Версія: abc1234 · 2026-09-30 — hourly pay/);
  await h.cb(OWNER, 'st:update');
  await new Promise((r) => setTimeout(r, 900));
  assert.strictEqual(restarted, 1);
  await h.text(OWNER, '/version');
  assert.match(h.lastText(OWNER), /Версія: abc1234/);
});
