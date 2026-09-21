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
const { createAssistant, priceOf } = require('../src/ai');
const { extractText } = require('../src/extract');

const at = (date, time) => new Date(T.kyivToIso(date, time));

/** Фальшивий OpenAI: script = масив відповідей; записує кожен запит. */
function fakeClient(script) {
  const requests = [];
  let i = 0;
  return {
    requests,
    chat: { completions: { create: async (req) => {
      requests.push(req);
      const step = script[Math.min(i++, script.length - 1)];
      if (step instanceof Error) throw step;
      return { choices: [{ message: step.message }], usage: step.usage || { prompt_tokens: 1000, completion_tokens: 100 } };
    } } },
  };
}
const toolCall = (name, args, id = 'c1') => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const final = (text) => ({ role: 'assistant', content: text });

function seeded() {
  const db = open(':memory:');
  const yu = E.byId(db, 1); const ow = E.byId(db, 4);
  E.link(db, yu.id, 2001, null); E.link(db, ow.id, 1000, null);
  S.start(db, yu, at('2026-09-01', '09:00')); S.end(db, yu, at('2026-09-01', '15:00'));
  S.start(db, yu, at('2026-09-02', '09:00')); S.end(db, yu, at('2026-09-02', '15:00'));
  P.addLedger(db, { emp_id: yu.id, type: 'advance', amount: 500, idem_key: 'a' });
  return { db, yu: E.byId(db, 1), ow: E.byId(db, 4) };
}
const now = () => at('2026-09-21', '12:00');

test('admin: tool round-trip with payroll data, usage recorded', async () => {
  const { db, ow } = seeded();
  const client = fakeClient([{ message: toolCall('payroll', { month: '2026-09' }) }, { message: final('Юлія: 2 дні, 2 800 грн, аванс 500.') }]);
  const ai = createAssistant({ db, client, model: 'gpt-4.1-mini', now });
  const r = await ai.ask(ow, 'Скільки нараховано Юлії?');
  assert.strictEqual(r.ok, true); assert.match(r.text, /2 800/);
  assert.strictEqual(client.requests.length, 2);
  const toolMsg = client.requests[1].messages.find((m) => m.role === 'tool');
  const data = JSON.parse(toolMsg.content);
  assert.strictEqual(data.rows[0].name, 'Юлія'); assert.strictEqual(data.rows[0].accrued, 2800); assert.strictEqual(data.rows[0].advances, 500);
  assert.ok(client.requests[0].tools.some((t) => t.function.name === 'payroll'));
  const u = ai.usage();
  assert.strictEqual(u.calls, 2); assert.strictEqual(u.input_tokens, 2000);
  assert.ok(Math.abs(u.cost_usd - (2000 * 0.4 + 200 * 1.6) / 1e6) < 1e-9);
  // memory: the next question carries the previous exchange
  client.requests.length = 0;
  await ai.ask(ow, 'а Ірині?');
  assert.ok(client.requests[0].messages.some((m) => m.role === 'assistant' && /2 800/.test(m.content)));
});

test('employee: only my_summary is offered and admin tools are refused', async () => {
  const { db, yu } = seeded();
  const client = fakeClient([{ message: toolCall('payroll', {}, 'x1') }, { message: toolCall('my_summary', {}, 'x2') }, { message: final('Ваш залишок 2 300 грн.') }]);
  const ai = createAssistant({ db, client, now });
  const r = await ai.ask(yu, 'скільки мені винні?');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(client.requests[0].tools.map((t) => t.function.name), ['my_summary']);
  const tools = client.requests[2].messages.filter((m) => m.role === 'tool');
  assert.strictEqual(tools[0].content, 'Недостатньо прав.');
  const mine = JSON.parse(tools[1].content);
  assert.deepStrictEqual([mine.employee, mine.days, mine.accrued, mine.balance], ['Юлія', 2, 2800, 2300]);
  assert.match(client.requests[0].messages[0].content, /Користувач: Юлія \(працівник\)/);
});

test('spend cap, API errors and missing key are reported honestly', async () => {
  const { db, ow } = seeded();
  db.prepare('INSERT INTO ai_usage (month, cost_usd, calls) VALUES (?, ?, 1)').run('2026-09', 9.9999);
  const client = fakeClient([{ message: final('ok') }]);
  const ai = createAssistant({ db, client, limitUsd: 10, now });
  assert.strictEqual((await ai.ask(ow, 'q')).ok, true);
  const capped = await ai.ask(ow, 'q');
  assert.strictEqual(capped.ok, false); assert.match(capped.text, /ліміт витрат/);
  const err429 = Object.assign(new Error('rate'), { status: 429 });
  const ai2 = createAssistant({ db: open(':memory:'), client: fakeClient([err429]), now });
  assert.match((await ai2.ask(ow, 'q')).text, /перевантажений/);
  const ai3 = createAssistant({ db: open(':memory:'), client: fakeClient([Object.assign(new Error('x'), { status: 401 })]), now });
  assert.match((await ai3.ask(ow, 'q')).text, /Ключ OpenAI/);
  const ai4 = createAssistant({ db: open(':memory:'), client: fakeClient([new Error('ECONNRESET')]), now });
  assert.match((await ai4.ask(ow, 'q')).text, /недоступний/);
  const ai5 = createAssistant({ db: open(':memory:'), client: null, now });
  assert.match((await ai5.ask(ow, 'q')).text, /не налаштований/);
  assert.deepStrictEqual(priceOf('gpt-4.1-mini-2025-04-14'), [0.4, 1.6]);
  assert.deepStrictEqual(priceOf('something-new'), [2, 8]);
});

test('cash report content: excel is parsed, photo is attached as an image, unreadable is admitted', async () => {
  const { db, ow } = seeded();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ln9ai-'));
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Дата', 'Готівка', 'Термінал'], ['21.09.2026', 5200, 3100]]), 'Каса');
  const xfile = path.join(dir, 'kasa.xlsx'); XLSX.writeFile(wb, xfile);
  const pfile = path.join(dir, 'photo.jpg'); fs.writeFileSync(pfile, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const bfile = path.join(dir, 'scan.bin'); fs.writeFileSync(bfile, 'zzz');
  const x = R.add(db, { date: '2026-09-21', kind: 'document', file_name: 'kasa.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', local_path: xfile, author: 'Власник' });
  const p = R.add(db, { date: '2026-09-21', kind: 'photo', mime: 'image/jpeg', local_path: pfile, author: 'Юлія' });
  const b = R.add(db, { date: '2026-09-21', kind: 'document', file_name: 'scan.bin', mime: 'application/octet-stream', local_path: bfile, author: 'Юлія' });
  const client = fakeClient([{ message: toolCall('cash_report_content', { id: x.id }) }, { message: final('Готівка 5 200, термінал 3 100.') }]);
  const ai = createAssistant({ db, client, now });
  await ai.ask(ow, 'що у звіті 1?');
  const tool = client.requests[1].messages.find((m) => m.role === 'tool');
  assert.match(tool.content, /Аркуш: Каса[\s\S]*5200,3100/);
  // photo → an image message follows the tool result
  const client2 = fakeClient([{ message: toolCall('cash_report_content', { id: p.id }) }, { message: final('На фото…') }]);
  const ai2 = createAssistant({ db, client: client2, now });
  await ai2.ask(ow, 'що на фото 2?');
  const msgs = client2.requests[1].messages;
  const img = msgs.filter((m) => m.role === 'user' && Array.isArray(m.content)).pop();
  assert.ok(img.content.some((c) => c.type === 'image_url' && c.image_url.url.startsWith('data:image/jpeg;base64,')));
  assert.ok(msgs.indexOf(img) > msgs.findIndex((m) => m.role === 'tool'));
  // unreadable
  const r3 = await ai.runTool(ow, 'cash_report_content', { id: b.id });
  assert.match(r3.text, /не вдалося прочитати/);
  assert.strictEqual(await extractText(bfile, 'application/octet-stream', 'scan.bin'), null);
  assert.match(await extractText(xfile, '', 'kasa.xlsx'), /Готівка/);
  // attachment passed directly (the "Аналізувати" button on a photo)
  const client3 = fakeClient([{ message: final('Бачу чек.') }]);
  const ai3 = createAssistant({ db, client: client3, now });
  await ai3.ask(ow, 'проаналізуй', { attachment: { path: pfile, mime: 'image/jpeg' } });
  const u = client3.requests[0].messages.filter((m) => m.role === 'user' && Array.isArray(m.content)).pop();
  assert.ok(u.content.some((c) => c.type === 'image_url'));
});

test('persistence: data and sent-log survive a restart (file db)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ln9db-'));
  const file = path.join(dir, 'x.sqlite');
  let db = open(file);
  const yu = E.byId(db, 1);
  S.start(db, yu, at('2026-09-21', '08:00'));
  db.prepare('INSERT INTO sent_log (key) VALUES (?)').run('daily:2026-09-21');
  db.setting('admin_chat_id', '-5');
  db.close();
  db = open(file);
  assert.strictEqual(S.working(db).length, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM employees').get().c, 4); // no re-seed
  assert.ok(db.prepare('SELECT 1 FROM sent_log WHERE key = ?').get('daily:2026-09-21'));
  assert.strictEqual(db.setting('admin_chat_id'), '-5');
  const closed = S.autoClose(db, at('2026-09-21', '18:00'));
  assert.strictEqual(closed.length, 1);
  db.close();
});
