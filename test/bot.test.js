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
const { createBot, B } = require('../src/bot');
const { createNotifier } = require('../src/notify');
const { createScheduler } = require('../src/scheduler');
const config = require('../src/config');

const OWNER = 1000, GROUP = -100500, YU = 2001, IR = 2002;
const at = (date, time) => new Date(T.kyivToIso(date, time));

async function harness() {
  const db = open(':memory:');
  E.link(db, E.owner(db).id, OWNER, null);
  db.setting('admin_chat_id', String(GROUP));
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
  const aiLog = [];
  const ai = { ask: async (emp, q, o) => { aiLog.push({ emp: emp.name, q, o }); return { ok: true, text: `AI: ${q}` }; }, reset() {}, usage: () => ({ model: 'fake', calls: 0, cost_usd: 0, limitUsd: 10 }) };
  let clock = null;
  const scheduler = createScheduler({ db, notify, api: bot.api, now: () => clock || new Date() });
  Object.assign(deps, { notify, ai, scheduler });

  let n = 100;
  const from = (id) => ({ id, is_bot: false, first_name: `U${id}` });
  const text = (uid, t, chat) => bot.handleUpdate({ update_id: n++, message: { message_id: n, date: 0, chat: chat || { id: uid, type: 'private' }, from: from(uid), text: t, entities: t.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: t.split(' ')[0].length }] : undefined } });
  const cb = (uid, data, chat) => bot.handleUpdate({ update_id: n++, callback_query: { id: `q${n}`, from: from(uid), chat_instance: 'ci', data, message: { message_id: n, date: 0, chat: chat || { id: uid, type: 'private' }, text: 'm' } } });
  const photo = (uid, caption) => bot.handleUpdate({ update_id: n++, message: { message_id: n, date: 0, chat: { id: uid, type: 'private' }, from: from(uid), caption, photo: [{ file_id: 'small', file_unique_id: 'us', width: 90, height: 90, file_size: 100 }, { file_id: `big${n}`, file_unique_id: `ub${n}`, width: 1280, height: 960, file_size: 200000 }] } });
  const doc = (uid, file_name, mime_type, size = 5000) => bot.handleUpdate({ update_id: n++, message: { message_id: n, date: 0, chat: { id: uid, type: 'private' }, from: from(uid), document: { file_id: `doc${n}`, file_unique_id: `ud${n}`, file_name, mime_type, file_size: size } } });
  const sent = (chatId) => calls.filter((c) => c.method === 'sendMessage' && Number(c.payload.chat_id) === chatId).map((c) => c.payload);
  const last = (chatId) => { const s = sent(chatId); return s[s.length - 1]; };
  const lastText = (chatId) => (last(chatId) || {}).text || '';
  const kbTexts = (p) => JSON.stringify((p && p.reply_markup) || {});
  const answers = () => calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.payload.text || '');
  return { db, bot, calls, failing, text, cb, photo, doc, sent, last, lastText, kbTexts, answers, aiLog, scheduler, notify, setClock: (d) => { clock = d; } };
}

test('unlinked user sees their ID; owner gets the admin menu', async () => {
  const h = await harness();
  await h.text(5555, '/start');
  assert.match(h.lastText(5555), /Telegram ID: <code>5555<\/code>/);
  await h.text(OWNER, '/start');
  assert.match(h.lastText(OWNER), /Вітаю, Власник/);
  const kb = h.kbTexts(h.last(OWNER));
  for (const b of [B.employees, B.working, B.history, B.payroll, B.advance, B.payout, B.fixShift, B.cashReport, B.monthly, B.ai, B.alarm, B.settings, '🟢 Прийшов']) assert.ok(kb.includes(b), `missing ${b}`);
});

test('linking by one-time code, then attendance with dedupe and group notices', async () => {
  const h = await harness();
  await h.text(OWNER, B.employees);
  assert.match(h.kbTexts(h.last(OWNER)), /em:v:1/);
  await h.cb(OWNER, 'em:v:1');
  assert.match(h.lastText(OWNER), /Юлія.*працівник/s);
  await h.cb(OWNER, 'em:code:1');
  const code = h.lastText(OWNER).match(/<code>(\d{6})<\/code>/)[1];
  await h.text(YU, '/start');
  assert.match(h.lastText(YU), /ще не прив'язано/);
  await h.text(YU, code);
  assert.match(h.lastText(YU), /Ви — <b>Юлія<\/b>/);
  assert.match(h.kbTexts(h.last(YU)), /🟢 Прийшла/);
  assert.doesNotMatch(h.kbTexts(h.last(YU)), /ТЕРМІНОВО/);
  assert.match(h.lastText(GROUP), /Юлія прив'язав/);
  await h.text(YU, code); // code is one-time and the user is linked already → normal menu
  assert.match(h.lastText(YU), /Оберіть дію/);

  await h.text(YU, '🟢 Прийшла');
  assert.match(h.lastText(YU), /Прихід відмічено/);
  assert.match(h.lastText(GROUP), /🟢 <b>Юлія<\/b> прийшла/);
  await h.text(YU, '🟢 Прийшла');
  assert.match(h.lastText(YU), /вже відкрита/);
  assert.strictEqual(h.db.prepare('SELECT COUNT(*) c FROM shifts').get().c, 1);
  await h.text(YU, '📊 Моя статистика');
  assert.match(h.lastText(YU), /Зараз на зміні/);
  await h.text(YU, '🔴 Пішла');
  assert.match(h.lastText(YU), /Зміну закрито/);
  assert.match(h.lastText(GROUP), /🔴 <b>Юлія<\/b> пішла/);
  await h.text(YU, '🔴 Пішла');
  assert.match(h.lastText(YU), /Відкритої зміни немає/);
  await h.text(YU, '💰 Моя зарплата');
  assert.match(h.lastText(YU), /Робочих днів: <b>1<\/b>[\s\S]*Нараховано за місяць: <b>1 400 грн<\/b>/);
});

test('advance flow: confirmation, double tap ignored, employee cannot use it', async () => {
  const h = await harness();
  E.link(h.db, 1, YU, null);
  await h.text(OWNER, B.advance);
  assert.match(h.kbTexts(h.last(OWNER)), /led:emp:1/);
  assert.doesNotMatch(h.kbTexts(h.last(OWNER)), /led:emp:4/); // the owner is not payable
  await h.cb(OWNER, 'led:emp:1');
  await h.text(OWNER, 'abc');
  assert.match(h.lastText(OWNER), /ціле число/);
  await h.text(OWNER, '1000');
  await h.text(OWNER, 'за тиждень');
  const nonce = h.kbTexts(h.last(OWNER)).match(/led:ok:([0-9a-f]+)/)[1];
  await h.cb(OWNER, `led:ok:${nonce}`);
  assert.match(h.lastText(OWNER), /Аванс <b>1 000 грн<\/b> для <b>Юлія<\/b> записано/);
  assert.match(h.lastText(GROUP), /➕ Аванс 1 000 грн — Юлія \(за тиждень\)\nДодав\(ла\): Власник/);
  await h.cb(OWNER, `led:ok:${nonce}`);
  assert.strictEqual(h.db.prepare('SELECT COUNT(*) c FROM ledger').get().c, 1);
  assert.ok(h.answers().some((t) => /вже виконано/.test(t)));
  // employee side
  await h.text(YU, B.advance);
  assert.match(h.lastText(YU), /Оберіть дію/);
  await h.cb(YU, 'led:emp:1');
  assert.strictEqual(h.bot.flows.size, 0);
  await h.text(YU, B.salary);
  assert.match(h.lastText(YU), /Аванси за місяць: 1 000 грн[\s\S]*Залишок до виплати: -1 000 грн/);
});

test('payout + salary screens + monthly report', async () => {
  const h = await harness();
  E.link(h.db, 1, YU, null);
  const yu = E.byId(h.db, 1);
  S.start(h.db, yu, at('2026-09-01', '09:00')); S.end(h.db, yu, at('2026-09-01', '15:00'));
  await h.text(OWNER, B.payout);
  await h.cb(OWNER, 'led:emp:1');
  await h.text(OWNER, '500');
  await h.text(OWNER, B.skip);
  const nonce = h.kbTexts(h.last(OWNER)).match(/led:ok:([0-9a-f]+)/)[1];
  await h.cb(OWNER, `led:ok:${nonce}`);
  assert.match(h.lastText(OWNER), /Виплату <b>500 грн<\/b>/);
  await h.text(OWNER, B.payroll);
  await h.cb(OWNER, 'sal:e:1:2026-09');
  assert.match(h.lastText(OWNER), /Нараховано за місяць: <b>1 400 грн<\/b>[\s\S]*Виплати за місяць: 500 грн[\s\S]*Залишок до виплати: 900 грн/);
  await h.cb(OWNER, 'sal:h:1');
  assert.match(h.lastText(OWNER), /виплата 500 грн/);
  await h.text(OWNER, B.monthly);
  const t = h.lastText(OWNER);
  assert.match(t, /Місячний звіт — вересень 2026/);
  assert.match(t, /Прибиральник.*12000 грн\/міс/);
  assert.doesNotMatch(t, /Власник/);
  assert.match(t, /Разом:<\/b> нараховано 13 400 грн/);
});

test('cash reports: photo, excel, list, search by date, AI analysis with attachment', async () => {
  const h = await harness();
  E.link(h.db, 1, YU, null);
  await h.photo(YU, 'вечірня каса');
  assert.match(h.lastText(YU), /Дякую/);
  const rep = h.db.prepare('SELECT * FROM reports WHERE id = 1').get();
  assert.strictEqual(rep.kind, 'photo'); assert.strictEqual(rep.author, 'Юлія'); assert.strictEqual(rep.comment, 'вечірня каса');
  assert.ok(fs.existsSync(rep.local_path));
  assert.match(h.lastText(GROUP), /Звіт каси #1 від Юлія/);
  assert.ok(h.calls.some((c) => c.method === 'sendPhoto' && Number(c.payload.chat_id) === GROUP));
  await h.text(OWNER, B.cashReport);
  await h.doc(OWNER, 'kasa.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.strictEqual(h.db.prepare('SELECT kind FROM reports WHERE id = 2').get().kind, 'document');
  await h.text(OWNER, B.cashReport);
  await h.text(OWNER, 'Каса 5 200 грн, термінал 3 100');
  assert.strictEqual(h.db.prepare('SELECT comment FROM reports WHERE id = 3').get().comment, 'Каса 5 200 грн, термінал 3 100');
  // an oversized file keeps only the Telegram link
  await h.doc(OWNER, 'huge.pdf', 'application/pdf', 30 * 1024 * 1024);
  assert.strictEqual(h.db.prepare('SELECT local_path FROM reports WHERE id = 4').get().local_path, null);
  assert.match(h.sent(OWNER).map((p) => p.text).join('\n'), /більший за 20 МБ/);

  await h.text(OWNER, B.viewReports);
  await h.cb(OWNER, 'rv:recent');
  assert.ok(h.calls.some((c) => c.method === 'sendPhoto' && Number(c.payload.chat_id) === OWNER && c.payload.photo === rep.file_id));
  assert.ok(h.calls.some((c) => c.method === 'sendDocument' && Number(c.payload.chat_id) === OWNER));
  await h.cb(OWNER, 'rv:date');
  await h.text(OWNER, '01.01.2020');
  assert.match(h.lastText(OWNER), /звітів немає/);
  await h.cb(OWNER, 'rp:ai:1');
  assert.strictEqual(h.aiLog.length, 1);
  assert.strictEqual(h.aiLog[0].o.attachment.path, rep.local_path);
  assert.match(h.lastText(OWNER), /^AI: Проаналізуй касовий звіт #1/);
  // employees may not analyse
  await h.cb(YU, 'rp:ai:1');
  assert.strictEqual(h.aiLog.length, 1);
  await h.cb(YU, 'rp:cm:1');
  await h.text(YU, 'уточнення');
  assert.strictEqual(h.db.prepare('SELECT comment FROM reports WHERE id = 1').get().comment, 'уточнення');
});

test('alarm: confirmation, delivery reported honestly, failures not hidden', async () => {
  const h = await harness();
  E.link(h.db, 2, IR, null); E.setRole(h.db, 2, 'admin', null);
  await h.text(IR, B.alarm);
  assert.match(h.kbTexts(h.last(IR)), /al:yes/);
  await h.cb(IR, 'al:yes');
  await h.text(IR, 'Прорвало трубу в залі');
  assert.match(h.lastText(OWNER), /🚨🚨🚨 <b>ТЕРМІНОВО<\/b>\nВід: <b>Ірина<\/b>[\s\S]*Прорвало трубу/);
  assert.match(h.lastText(GROUP), /ТЕРМІНОВО/);
  assert.match(h.lastText(IR), /✅ Доставлено власнику\n✅ Доставлено в адмін-чат/);
  let al = h.db.prepare('SELECT * FROM alerts ORDER BY id DESC').get();
  assert.deepStrictEqual([al.delivered_owner, al.delivered_group, al.author], [1, 1, 'Ірина']);
  // group broken
  h.failing.add(GROUP);
  await h.text(IR, B.alarm); await h.cb(IR, 'al:yes'); await h.text(IR, B.noText);
  assert.match(h.lastText(IR), /✅ Доставлено власнику\n❌ В адмін-чат НЕ доставлено/);
  al = h.db.prepare('SELECT * FROM alerts ORDER BY id DESC').get();
  assert.deepStrictEqual([al.delivered_owner, al.delivered_group, al.text], [1, 0, '']);
  // employee cannot trigger
  E.link(h.db, 1, YU, null);
  await h.text(YU, B.alarm);
  assert.strictEqual(h.bot.flows.size, 0);
});

test('AI mode for an employee and /ai in the group for admins', async () => {
  const h = await harness();
  E.link(h.db, 1, YU, null);
  await h.text(YU, B.ai);
  assert.match(h.kbTexts(h.last(YU)), /Вийти з AI/);
  await h.text(YU, 'скільки я заробила?');
  assert.deepStrictEqual([h.aiLog[0].emp, h.aiLog[0].q], ['Юлія', 'скільки я заробила?']);
  assert.match(h.lastText(YU), /^AI: скільки/);
  await h.text(YU, B.exitAi);
  assert.match(h.lastText(YU), /Режим AI вимкнено/);
  await h.text(YU, 'привіт');
  assert.strictEqual(h.aiLog.length, 1);
  const g = { id: GROUP, type: 'supergroup' };
  await h.text(YU, '/ai хто працює', g);
  assert.strictEqual(h.aiLog.length, 1);
  await h.text(OWNER, '/ai хто працює', g);
  assert.strictEqual(h.aiLog.length, 2);
  assert.match(h.lastText(GROUP), /^AI: хто працює/);
});

test('scheduler: auto-close via tick, daily report once, backup key', async () => {
  const h = await harness();
  const yu = E.byId(h.db, 1);
  const startAt = at('2026-09-21', '08:00');
  S.start(h.db, yu, startAt);
  h.setClock(at('2026-09-21', '17:00'));
  let r = await h.scheduler.tick(at('2026-09-21', '17:00'));
  assert.strictEqual(r.closed.length, 0);
  r = await h.scheduler.tick(at('2026-09-21', '18:00'));
  assert.strictEqual(r.closed.length, 1);
  assert.match(h.lastText(GROUP), /Юлія<\/b> — зміну закрито автоматично через 10 год\n08:00–18:00/);
  assert.strictEqual(r.daily, false);
  r = await h.scheduler.tick(at('2026-09-21', '22:30'));
  assert.strictEqual(r.daily, true);
  const rep = h.lastText(GROUP);
  assert.match(rep, /Підсумок дня 21.09.2026 \(пн\)/);
  assert.match(rep, /Прийшли:<\/b>\n• Юлія — 08:00–18:00 · автозакрито/);
  assert.match(rep, /Не відмітились:<\/b>\n• Ірина\n• Прибиральник/);
  assert.match(rep, /Нараховано за день:<\/b> 1 400 грн/);
  assert.match(h.lastText(OWNER), /Підсумок дня/);
  r = await h.scheduler.tick(at('2026-09-21', '23:10'));
  assert.strictEqual(r.daily, false); // sent once
  assert.strictEqual(h.sent(GROUP).filter((p) => /Підсумок дня/.test(p.text)).length, 1);
  // the setting overrides the env time
  h.db.setting('daily_report_time', '21:00');
  r = await h.scheduler.tick(at('2026-09-22', '21:00'));
  assert.strictEqual(r.daily, true);
});

test('fix shift: change end time, add a shift manually, delete with confirmation', async () => {
  const h = await harness();
  const yu = E.byId(h.db, 1);
  const { shift } = S.start(h.db, yu, at('2026-09-21', '08:00'));
  await h.text(OWNER, B.fixShift);
  await h.cb(OWNER, 'fx:emp:1');
  assert.match(h.kbTexts(h.last(OWNER)), new RegExp(`fx:s:${shift.id}`));
  await h.cb(OWNER, `fx:s:${shift.id}`);
  await h.cb(OWNER, `fx:en:${shift.id}`);
  await h.text(OWNER, '16:00');
  assert.match(h.lastText(OWNER), /Зміну виправлено: Юлія 21.09.2026 08:00–16:00/);
  assert.match(h.lastText(GROUP), /виправив\(ла\) зміну Юлія/);
  await h.cb(OWNER, 'fx:new:1');
  await h.text(OWNER, '20.09.2026'); await h.text(OWNER, '09:00'); await h.text(OWNER, '15:30');
  assert.match(h.lastText(OWNER), /Зміну додано: Юлія 20.09.2026 09:00–15:30/);
  assert.strictEqual(h.db.prepare('SELECT COUNT(DISTINCT date) c FROM shifts WHERE emp_id = 1').get().c, 2);
  await h.cb(OWNER, `fx:del:${shift.id}`);
  assert.match(h.kbTexts(h.last(OWNER)), /fx:delok/);
  await h.cb(OWNER, `fx:delok:${shift.id}`);
  assert.match(h.lastText(OWNER), /Зміну видалено/);
  assert.strictEqual(h.db.prepare('SELECT COUNT(*) c FROM shifts').get().c, 1);
});

test('admin group setup via /chatid, settings screen, who is working, history', async () => {
  const h = await harness();
  h.db.setting('admin_chat_id', null);
  const g = { id: -777, type: 'supergroup' };
  await h.text(OWNER, '/chatid', g);
  assert.match(h.lastText(-777), /ID цього чату: <code>-777<\/code>/);
  assert.match(h.kbTexts(h.last(-777)), /st:group:-777/);
  await h.cb(OWNER, 'st:group:-777', g);
  assert.strictEqual(h.notify.groupId(), -777);
  await h.text(OWNER, B.settings);
  assert.match(h.lastText(OWNER), /Адмін-група: підключено \(ID -777\)[\s\S]*Щоденний підсумок: 22:30/);
  await h.cb(OWNER, 'st:time'); await h.text(OWNER, '21:15');
  assert.strictEqual(h.scheduler.reportTime(), '21:15');
  await h.cb(OWNER, 'st:test');
  assert.match(h.lastText(OWNER), /Доставлено в адмін-чат/);
  S.start(h.db, E.byId(h.db, 2), new Date());
  await h.text(OWNER, B.working);
  assert.match(h.lastText(OWNER), /• Ірина — з/);
  await h.text(OWNER, B.history); await h.cb(OWNER, 'hs:all');
  assert.match(h.lastText(OWNER), /• Ірина: /);
  // employee management: add + rate change (owner only) + telegram id by hand
  await h.cb(OWNER, 'em:add'); await h.text(OWNER, 'Олена'); await h.cb(OWNER, 'em:pt:daily'); await h.text(OWNER, '1200'); await h.cb(OWNER, 'em:g:f');
  const ol = h.db.prepare("SELECT * FROM employees WHERE name = 'Олена'").get();
  assert.deepStrictEqual([ol.pay_type, ol.rate, ol.gender], ['daily', 1200, 'f']);
  await h.cb(OWNER, 'em:add'); await h.text(OWNER, 'Максим'); await h.cb(OWNER, 'em:pt:none'); await h.cb(OWNER, 'em:g:m');
  const mx = h.db.prepare("SELECT * FROM employees WHERE name = 'Максим'").get();
  assert.deepStrictEqual([mx.pay_type, mx.rate], ['none', 0]);
  await h.cb(OWNER, `em:adm:${mx.id}`);
  assert.strictEqual(E.byId(h.db, mx.id).role, 'admin');
  await h.text(OWNER, B.monthly);
  assert.doesNotMatch(h.lastText(OWNER), /Максим/);
  await h.cb(OWNER, `em:tg:${ol.id}`); await h.text(OWNER, '3003');
  assert.strictEqual(E.byTelegram(h.db, 3003).name, 'Олена');
  await h.cb(OWNER, 'em:rate:3'); await h.text(OWNER, '13000');
  const nonce = h.kbTexts(h.last(OWNER)).match(/em:rateok:3:([0-9a-f]+)/)[1];
  await h.cb(OWNER, `em:rateok:3:${nonce}`);
  assert.strictEqual(E.byId(h.db, 3).rate, 13000);
  assert.match(h.lastText(-777), /змінив\(ла\) ставку Прибиральник: 13000 грн\/міс/);
  // an admin who is not the owner may not change rates
  E.link(h.db, 2, IR, null); E.setRole(h.db, 2, 'admin', null);
  await h.cb(IR, 'em:rate:3');
  assert.ok(h.answers().some((t) => /лише власник/.test(t)));
});
