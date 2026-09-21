'use strict';
// AI-помічник: OpenAI з інструментами лише для читання. Ніяких змін у базі звідси.
const fs = require('fs');
const config = require('./config');
const T = require('./time');
const E = require('./employees');
const S = require('./shifts');
const P = require('./payroll');
const R = require('./reports');
const { extractText, isImage } = require('./extract');

// USD за 1M токенів [вхід, вихід]; невідома модель → обережна оцінка
const PRICES = {
  'gpt-4.1-mini': [0.4, 1.6], 'gpt-4.1-nano': [0.1, 0.4], 'gpt-4.1': [2, 8],
  'gpt-4o-mini': [0.15, 0.6], 'gpt-4o': [2.5, 10], 'gpt-5-mini': [0.25, 2], 'gpt-5': [1.25, 10], 'gpt-5-nano': [0.05, 0.4],
};
const priceOf = (model) => PRICES[model] || PRICES[Object.keys(PRICES).find((k) => model.startsWith(k))] || [2, 8];

const SYSTEM = `Ти — AI-помічник Telegram-бота «Облік працівників» спортзалу LEVEL NINE GYM. Відповідай українською, коротко і по суті.

Що вміє бот (пояснюй це працівникам):
- 🟢 «Прийшла / Прийшов» — відмітка приходу на початку робочого дня. Повторне натискання нову зміну не створює.
- 🔴 «Пішла / Пішов» — закриття зміни. Якщо забути, бот сам закриє зміну через 10 годин після початку і позначить «автоматично закрито». На зарплату це не впливає.
- 📊 «Моя статистика» — зміни за місяць. 💰 «Моя зарплата» — нараховано, аванси, виплати, залишок.
- Юлія та Ірина отримують фіксовано 1 400 грн за робочий день незалежно від годин. Прибиральник — 12 000 грн на місяць. Власник — 0 грн.
- Графік контролю присутності: Пн–Пт 08:00–22:00, Сб 09:00–18:00, Нд 09:00–16:00. Відмітка поза графіком зберігається як є, адміністратор отримує повідомлення.
- Адміністратор має меню: Працівники, Хто працює, Історія змін, Зарплата, Додати аванс, Додати виплату, Виправити зміну, Звіт каси, Місячний звіт, AI-помічник, Терміново, Налаштування.
- 📸 «Надіслати звіт каси» — фото, PDF, Excel або текст; бот зберігає дату, автора, коментар і файл. 📁 «Переглянути звіти» — останні або за датою.
- 🚨 «ТЕРМІНОВО» — після підтвердження негайно надсилає повідомлення власнику та в адмін-чат.

Правила:
- Ти НЕ можеш нічого змінювати: ні зарплат, ні авансів, ні виплат, ні змін, ні прав доступу. Якщо просять — поясни, якою кнопкою це робить адміністратор.
- Використовуй інструменти, щоб отримати дані. Не вигадуй суми, дати чи імена. Якщо даних немає або документ нечитабельний — скажи прямо.
- Працівник бачить лише власні дані. Не показуй чужі зарплати або приватну інформацію.
- Якщо просять скласти повідомлення працівнику чи клієнту — напиши ввічливий текст українською.`;

function tools(emp) {
  const admin = E.isAdmin(emp);
  const list = [
    { type: 'function', function: { name: 'my_summary', description: 'Зміни, дні, нараховано, аванси, виплати й залишок поточного або вказаного місяця для користувача, який пише.', parameters: { type: 'object', properties: { month: { type: 'string', description: 'YYYY-MM; за замовчуванням поточний' } } } } },
  ];
  if (admin) list.push(
    { type: 'function', function: { name: 'list_employees', description: 'Список працівників зі ставками, ролями й станом прив’язки.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'who_is_working', description: 'Хто зараз на зміні.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'shifts', description: 'Зміни за період (за замовчуванням останні 14 днів), опційно одного працівника.', parameters: { type: 'object', properties: { employee: { type: 'string' }, from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' } } } } },
    { type: 'function', function: { name: 'payroll', description: 'Зарплатні підсумки місяця по всіх працівниках: нараховано, аванси, виплати, залишок, історія операцій.', parameters: { type: 'object', properties: { month: { type: 'string', description: 'YYYY-MM' } } } } },
    { type: 'function', function: { name: 'cash_reports', description: 'Список касових звітів (останні або за датою).', parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, limit: { type: 'integer' } } } } },
    { type: 'function', function: { name: 'cash_report_content', description: 'Вміст касового звіту за його номером: текст із Excel/PDF/тексту або саме фото для аналізу.', parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } } },
  );
  return list;
}

function createAssistant({ db, client, model = config.openaiModel, limitUsd = config.openaiMonthlyLimitUsd, now = () => new Date() }) {
  const history = new Map(); // telegram_id → останні репліки

  function spent(month) {
    return db.prepare('SELECT * FROM ai_usage WHERE month = ?').get(month) || { month, input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 };
  }
  function record(month, usage) {
    const [pi, po] = priceOf(model);
    const cost = ((usage.prompt_tokens || 0) * pi + (usage.completion_tokens || 0) * po) / 1e6;
    db.prepare(`INSERT INTO ai_usage (month, input_tokens, output_tokens, cost_usd, calls) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(month) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens, cost_usd = cost_usd + excluded.cost_usd, calls = calls + 1`)
      .run(month, usage.prompt_tokens || 0, usage.completion_tokens || 0, cost);
  }

  async function runTool(emp, name, args) {
    const p = T.parts(now());
    const admin = E.isAdmin(emp);
    if (name === 'my_summary') {
      const month = /^\d{4}-\d{2}$/.test(args.month || '') ? args.month : p.month;
      const s = P.summary(db, emp, month, p.month);
      const sh = S.forEmployee(db, emp.id, `${month}-01`, `${month}-31`).map(S.line);
      return { text: JSON.stringify({ employee: emp.name, pay: E.payText(emp), ...s, shifts: sh }) };
    }
    if (!admin) return { text: 'Недостатньо прав.' };
    if (name === 'list_employees') return { text: JSON.stringify(E.list(db).map((e) => ({ name: e.name, role: E.roleText(e), pay: E.payText(e), linked: !!e.telegram_id }))) };
    if (name === 'who_is_working') return { text: JSON.stringify(S.working(db).map((s) => ({ name: s.name, since: T.uaDateTime(s.started_at) }))) };
    if (name === 'shifts') {
      const to = T.parseDate(args.to) || p.date; const from = T.parseDate(args.from) || T.addDays(to, -14);
      let rows = db.prepare('SELECT s.*, e.name FROM shifts s JOIN employees e ON e.id = s.emp_id WHERE s.date >= ? AND s.date <= ? ORDER BY s.started_at DESC LIMIT 200').all(from, to);
      if (args.employee) rows = rows.filter((r) => r.name.toLowerCase().includes(String(args.employee).toLowerCase()));
      return { text: JSON.stringify(rows.map((r) => `${r.name}: ${S.line(r)}`)) };
    }
    if (name === 'payroll') {
      const month = /^\d{4}-\d{2}$/.test(args.month || '') ? args.month : p.month;
      const rep = P.monthlyReport(db, month, p.month);
      return { text: JSON.stringify({ month, rows: rep.rows.map((r) => ({ name: r.emp.name, pay: E.payText(r.emp), days: r.days, accrued: r.accrued, advances: r.advances, payouts: r.payouts, balance: r.balance, history: P.history(db, r.emp.id, 10).map(P.ledgerLine) })), total: rep.total }) };
    }
    if (name === 'cash_reports') {
      const date = T.parseDate(args.date);
      const rows = date ? R.onDate(db, date) : R.recent(db, Math.min(30, args.limit || 10));
      return { text: rows.length ? rows.map(R.line).join('\n') : 'Звітів немає.' };
    }
    if (name === 'cash_report_content') {
      const r = R.byId(db, args.id);
      if (!r) return { text: 'Звіт не знайдено.' };
      if (r.kind === 'text') return { text: r.comment || '' };
      if (r.kind === 'photo' || isImage(r.mime, r.file_name)) {
        if (r.local_path && fs.existsSync(r.local_path)) return { text: `Фото звіту #${r.id} додано до повідомлення нижче.`, image: r.local_path, mime: r.mime || 'image/jpeg' };
        return { text: 'Файл фото недоступний на сервері — прочитати неможливо.' };
      }
      const text = await extractText(r.local_path, r.mime, r.file_name);
      return { text: text || `Документ ${r.file_name || ''} не вдалося прочитати як текст (можливо, скан або невідомий формат).` };
    }
    return { text: 'Невідомий інструмент.' };
  }

  /** Відповідь на питання користувача. attachment: {path, mime} — фото для аналізу. */
  async function ask(emp, question, { attachment = null, chatKey = null } = {}) {
    if (!client) return { ok: false, text: '🤖 AI-помічник не налаштований: немає OPENAI_API_KEY.' };
    const month = T.parts(now()).month;
    const used = spent(month);
    if (used.cost_usd >= limitUsd) return { ok: false, text: `🤖 Місячний ліміт витрат на AI (${limitUsd} $) вичерпано. Адміністратор може підняти ліміт у налаштуваннях сервера.` };

    const key = chatKey || emp.telegram_id || emp.id;
    const prior = history.get(key) || [];
    const userContent = [{ type: 'text', text: question }];
    if (attachment && fs.existsSync(attachment.path)) {
      userContent.push({ type: 'image_url', image_url: { url: `data:${attachment.mime || 'image/jpeg'};base64,${fs.readFileSync(attachment.path).toString('base64')}` } });
    }
    const messages = [
      { role: 'system', content: `${SYSTEM}\n\nКористувач: ${emp.name} (${E.roleText(emp)}). Сьогодні ${T.uaDate(T.parts(now()).date)}, ${T.parts(now()).time} (Київ).` },
      ...prior,
      { role: 'user', content: userContent },
    ];
    try {
      let reply = '';
      for (let round = 0; round < 5; round++) {
        const res = await client.chat.completions.create({ model, messages, tools: tools(emp), tool_choice: 'auto', max_tokens: 900 });
        if (res.usage) record(month, res.usage);
        const msg = res.choices[0].message;
        messages.push(msg);
        if (!msg.tool_calls || !msg.tool_calls.length) { reply = msg.content || ''; break; }
        const images = [];
        for (const tc of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) { /* порожні аргументи */ }
          const out = await runTool(emp, tc.function.name, args);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: out.text });
          if (out.image) images.push(out);
        }
        for (const im of images) {
          messages.push({ role: 'user', content: [{ type: 'text', text: 'Фото касового звіту для аналізу:' }, { type: 'image_url', image_url: { url: `data:${im.mime};base64,${fs.readFileSync(im.image).toString('base64')}` } }] });
        }
      }
      if (!reply) reply = 'Не вдалося сформувати відповідь. Спробуйте переформулювати запитання.';
      const keep = [{ role: 'user', content: question }, { role: 'assistant', content: reply }];
      history.set(key, [...prior, ...keep].slice(-8));
      return { ok: true, text: reply };
    } catch (e) {
      console.error('openai error', e && e.message);
      const status = e && (e.status || (e.response && e.response.status));
      if (status === 429) return { ok: false, text: '🤖 AI зараз перевантажений або вичерпано квоту OpenAI. Спробуйте пізніше.' };
      if (status === 401) return { ok: false, text: '🤖 Ключ OpenAI не приймається. Перевірте OPENAI_API_KEY у налаштуваннях сервера.' };
      return { ok: false, text: '🤖 AI зараз недоступний. Спробуйте за кілька хвилин.' };
    }
  }

  function reset(key) { history.delete(key); }
  function usage() { const m = T.parts(now()).month; return { ...spent(m), limitUsd, model }; }

  return { ask, reset, usage, runTool, priceOf };
}

function makeClient() {
  if (!config.openaiKey) return null;
  const OpenAI = require('openai');
  return new OpenAI({ apiKey: config.openaiKey, timeout: 60000, maxRetries: 1 });
}

module.exports = { createAssistant, makeClient, PRICES, priceOf, SYSTEM };
