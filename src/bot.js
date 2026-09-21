'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Bot, Keyboard, InlineKeyboard, InputFile } = require('grammy');
const config = require('./config');
const T = require('./time');
const E = require('./employees');
const S = require('./shifts');
const P = require('./payroll');
const R = require('./reports');
const { esc } = require('./notify');
const { isImage } = require('./extract');

const B = {
  stats: '📊 Моя статистика', salary: '💰 Моя зарплата',
  sendReport: '📸 Надіслати звіт каси', viewReports: '📁 Переглянути звіти', ai: '🤖 AI-помічник',
  employees: '👥 Працівники', working: '🟢 Хто працює', history: '📅 Історія змін',
  payroll: '💰 Зарплата', advance: '➕ Додати аванс', payout: '💸 Додати виплату',
  fixShift: '📝 Виправити зміну', cashReport: '📸 Звіт каси', monthly: '📊 Місячний звіт',
  alarm: '🚨 ТЕРМІНОВО', settings: '⚙️ Налаштування',
  menu: '⬅️ Меню', cancel: '❌ Скасувати', skip: '➡️ Пропустити', exitAi: '⬅️ Вийти з AI', noText: '➡️ Без тексту',
};
const came = (e) => `🟢 ${E.came(e)}`;
const left = (e) => `🔴 ${E.left(e)}`;

function employeeKb(e) {
  return new Keyboard().text(came(e)).row().text(left(e)).row()
    .text(B.stats).text(B.salary).row().text(B.sendReport).text(B.ai).resized().persistent();
}
function adminKb(e) {
  return new Keyboard()
    .text(came(e)).text(left(e)).row()
    .text(B.employees).text(B.working).row()
    .text(B.history).text(B.payroll).row()
    .text(B.advance).text(B.payout).row()
    .text(B.fixShift).text(B.cashReport).row()
    .text(B.viewReports).text(B.monthly).row()
    .text(B.ai).text(B.alarm).row()
    .text(B.settings).resized().persistent();
}
const menuKb = (e) => (E.isAdmin(e) ? adminKb(e) : employeeKb(e));
const cancelKb = () => new Keyboard().text(B.cancel).resized();
const skipKb = () => new Keyboard().text(B.skip).text(B.cancel).resized();
const aiKb = () => new Keyboard().text(B.exitAi).resized().persistent();

const money = T.money;
const chunk = (text, n = 3800) => { const out = []; let cur = ''; for (const line of text.split('\n')) { if ((cur + line).length > n) { out.push(cur); cur = ''; } cur += (cur ? '\n' : '') + line; } if (cur) out.push(cur); return out; };

function createBot({ token = 'test', db, deps = {}, botInfo, download }) {
  const bot = new Bot(token, botInfo ? { botInfo } : undefined);
  // notify / ai / scheduler потребують bot.api, тому підставляються після створення бота (deps)
  const lazy = (k) => new Proxy({}, { get: (_, m) => deps[k][m] });
  const notify = lazy('notify'); const ai = lazy('ai'); const scheduler = lazy('scheduler');
  bot.deps = deps;
  const flows = new Map(); // telegram_id → {name, step, data}
  const flow = (id) => flows.get(id);
  const setFlow = (id, f) => flows.set(id, { data: {}, ...f });
  const clearFlow = (id) => flows.delete(id);

  const dl = download || (async (fileId, dest) => {
    const f = await bot.api.getFile(fileId);
    if (!f.file_path) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`);
    if (!res.ok) return null;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return dest;
  });

  async function say(ctx, text, kb) {
    const parts = chunk(text);
    let last;
    for (let i = 0; i < parts.length; i++) {
      const extra = { parse_mode: 'HTML' };
      if (kb && i === parts.length - 1) extra.reply_markup = kb;
      last = await ctx.reply(parts[i], extra);
    }
    return last;
  }
  const menu = (ctx, text = 'Головне меню') => say(ctx, text, menuKb(ctx.emp));
  const dropButtons = async (ctx) => { try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch (_) { /* повідомлення могло бути змінене */ } };
  const nonce = () => crypto.randomBytes(4).toString('hex');

  // ---------- хто пише ----------
  bot.use(async (ctx, next) => {
    ctx.emp = ctx.from ? E.byTelegram(db, ctx.from.id) : null;
    ctx.isPrivate = !!ctx.chat && ctx.chat.type === 'private';
    ctx.isAdmin = E.isAdmin(ctx.emp);
    await next();
  });

  // ---------- команди, що працюють усюди ----------
  bot.command(['chatid', 'id'], async (ctx) => {
    const lines = [`Ваш Telegram ID: <code>${ctx.from.id}</code>`];
    if (!ctx.isPrivate) lines.push(`ID цього чату: <code>${ctx.chat.id}</code>`);
    const kb = !ctx.isPrivate && ctx.isAdmin ? new InlineKeyboard().text('✅ Зробити цю групу адмін-чатом', `st:group:${ctx.chat.id}`) : undefined;
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
  });

  bot.command('ai', async (ctx) => {
    if (!ctx.emp || !ctx.isAdmin) return;
    const q = (ctx.match || '').trim();
    if (!q) return ctx.reply('Напишіть: /ai ваше запитання');
    await ctx.replyWithChatAction('typing').catch(() => {});
    const r = await ai.ask(ctx.emp, q, { chatKey: `chat:${ctx.chat.id}` });
    await say(ctx, esc(r.text));
  });

  bot.command('start', async (ctx) => {
    if (!ctx.isPrivate) return;
    const code = (ctx.match || '').trim();
    if (!ctx.emp && /^\d{6}$/.test(code)) return redeem(ctx, code);
    if (!ctx.emp) return notLinked(ctx);
    clearFlow(ctx.from.id);
    await menu(ctx, `Вітаю, ${esc(ctx.emp.name)}! Оберіть дію кнопкою нижче.`);
  });
  bot.command(['menu', 'help'], async (ctx) => {
    if (!ctx.isPrivate) return;
    if (!ctx.emp) return notLinked(ctx);
    clearFlow(ctx.from.id);
    await menu(ctx, helpText(ctx.emp));
  });

  function helpText(e) {
    const base = `<b>Як користуватись</b>\n${came(e)} — відмітити прихід вранці.\n${left(e)} — закрити зміну після роботи. Якщо забули — бот закриє її сам через ${config.autoCloseHours} год.\n${B.stats} — ваші зміни за місяць.\n${B.salary} — нараховано, аванси, виплати, залишок.\n${B.sendReport} — фото / PDF / Excel / текст звіту каси.\n${B.ai} — запитайте бота простими словами.`;
    if (!E.isAdmin(e)) return base;
    return base + `\n\n<b>Адміністратор</b>\n${B.employees} — ставки, прив'язка Telegram.\n${B.working} — хто зараз на зміні.\n${B.history} — останні зміни.\n${B.payroll} — по працівнику: нараховано / аванси / виплати / залишок.\n${B.advance} · ${B.payout} — операції з підтвердженням.\n${B.fixShift} — змінити час, закрити, видалити або додати зміну.\n${B.viewReports} — останні звіти або пошук за датою.\n${B.monthly} — підсумки місяця по всіх.\n${B.alarm} — негайне повідомлення власнику та в адмін-групу.\n${B.settings} — час щоденного звіту, адмін-група, резервна копія.`;
  }

  async function notLinked(ctx) {
    await ctx.reply(`Ваш Telegram ID: <code>${ctx.from.id}</code>\n\nЦей акаунт ще не прив'язано до працівника. Попросіть адміністратора надіслати вам 6-значний код і введіть його сюди.`, { parse_mode: 'HTML' });
  }
  async function redeem(ctx, code) {
    const r = E.redeemCode(db, code, ctx.from.id);
    if (!r.ok) return ctx.reply(`❌ ${r.reason}.`);
    ctx.emp = r.emp;
    await menu(ctx, `✅ Готово! Ви — <b>${esc(r.emp.name)}</b>. Оберіть дію кнопкою нижче.`);
    await notify.toGroup(`🔗 ${esc(r.emp.name)} прив'язав(ла) Telegram (ID ${ctx.from.id})`);
  }

  // ---------- inline-кнопки ----------
  bot.on('callback_query:data', async (ctx) => {
    const d = ctx.callbackQuery.data.split(':');
    try {
      if (!ctx.emp) { await ctx.answerCallbackQuery({ text: 'Спершу прив\'яжіть акаунт' }); return; }
      const handled = await onCallback(ctx, d);
      if (handled !== 'answered') await ctx.answerCallbackQuery().catch(() => {});
    } catch (e) {
      console.error('callback', ctx.callbackQuery.data, e);
      await ctx.answerCallbackQuery({ text: 'Помилка. Спробуйте ще раз.' }).catch(() => {});
    }
  });

  async function onCallback(ctx, d) {
    const uid = ctx.from.id; const f = flow(uid); const admin = ctx.isAdmin;
    const [k, a, b, c] = d;

    if (k === 'st' && a === 'group') {
      if (!admin) return;
      db.setting('admin_chat_id', b); db.audit(ctx.emp.id, 'settings.group', { chat: b });
      await dropButtons(ctx);
      await ctx.reply('✅ Ця група тепер адмін-чат: сюди йтимуть приходи, звіти каси, підсумки й тривоги.');
      return;
    }

    // --- аванс / виплата ---
    if (k === 'led') {
      if (!admin) return;
      if (a === 'emp') {
        if (!f || f.name !== 'ledger' || f.step !== 'emp') { await ctx.answerCallbackQuery({ text: 'Почніть операцію заново з меню' }); return 'answered'; }
        const emp = E.byId(db, +b); if (!emp) return;
        f.data.emp = emp; f.step = 'amount';
        await dropButtons(ctx);
        await say(ctx, `${f.type === 'advance' ? 'Аванс' : 'Виплата'} для <b>${esc(emp.name)}</b>.\nВведіть суму в гривнях (ціле число):`, cancelKb());
        return;
      }
      if (a === 'ok') {
        if (!f || f.name !== 'ledger' || f.step !== 'confirm' || f.data.nonce !== b) { await ctx.answerCallbackQuery({ text: 'Операцію вже виконано або скасовано', show_alert: true }); await dropButtons(ctx); return 'answered'; }
        clearFlow(uid); // спершу знімаємо стан — повторний тап уже нічого не зробить
        await dropButtons(ctx);
        const r = P.addLedger(db, { emp_id: f.data.emp.id, type: f.type, amount: f.data.amount, comment: f.data.comment, admin_id: ctx.emp.id, idem_key: `led:${uid}:${b}` });
        if (!r.ok) return menu(ctx, `❌ ${r.reason}`);
        const label = f.type === 'advance' ? 'Аванс' : 'Виплату';
        const s = P.summary(db, f.data.emp, T.parts().month);
        await menu(ctx, `✅ ${label} <b>${money(f.data.amount)}</b> для <b>${esc(f.data.emp.name)}</b> записано.${f.data.comment ? `\nКоментар: ${esc(f.data.comment)}` : ''}\nЗалишок до виплати: <b>${money(s.balance)}</b>`);
        await notify.toGroup(`${f.type === 'advance' ? '➕ Аванс' : '💸 Виплата'} ${money(f.data.amount)} — ${esc(f.data.emp.name)}${f.data.comment ? ` (${esc(f.data.comment)})` : ''}\nДодав(ла): ${esc(ctx.emp.name)}`);
        return;
      }
      if (a === 'no') { clearFlow(uid); await dropButtons(ctx); await menu(ctx, 'Скасовано.'); return; }
    }

    // --- тривога ---
    if (k === 'al') {
      if (!admin) return;
      if (a === 'yes') {
        if (!f || f.name !== 'alarm') { await ctx.answerCallbackQuery({ text: 'Почніть заново з меню' }); return 'answered'; }
        f.step = 'text'; await dropButtons(ctx);
        await say(ctx, 'Коротке повідомлення (що сталося), або натисніть «Без тексту»:', new Keyboard().text(B.noText).text(B.cancel).resized());
        return;
      }
      if (a === 'no') { clearFlow(uid); await dropButtons(ctx); await menu(ctx, 'Тривогу скасовано.'); return; }
    }

    // --- звіти каси ---
    if (k === 'rp') {
      const rep = R.byId(db, +b);
      if (!rep) { await ctx.answerCallbackQuery({ text: 'Звіт не знайдено' }); return 'answered'; }
      if (a === 'cm') {
        if (rep.telegram_id !== uid && !admin) return;
        setFlow(uid, { name: 'rpcomment', data: { id: rep.id } });
        await say(ctx, `Коментар до звіту #${rep.id}:`, cancelKb());
        return;
      }
      if (a === 'ai') {
        if (!admin) { await ctx.answerCallbackQuery({ text: 'Лише для адміністратора' }); return 'answered'; }
        await ctx.replyWithChatAction('typing').catch(() => {});
        const attachment = (rep.kind === 'photo' || isImage(rep.mime, rep.file_name)) && rep.local_path ? { path: rep.local_path, mime: rep.mime || 'image/jpeg' } : null;
        const r = await ai.ask(ctx.emp, `Проаналізуй касовий звіт #${rep.id}${rep.comment ? ` (коментар автора: ${rep.comment})` : ''}: що в ньому, які суми, чи є щось незвичне. Якщо дані нечитабельні — так і скажи.`, { attachment });
        await say(ctx, esc(r.text));
        return;
      }
    }
    if (k === 'rv') {
      if (!admin) return;
      if (a === 'today') return listReports(ctx, R.onDate(db, T.parts().date), `Звіти за сьогодні (${T.uaDate(T.parts().date)})`);
      if (a === 'recent') return listReports(ctx, R.recent(db, 10), 'Останні 10 звітів');
      if (a === 'date') { setFlow(uid, { name: 'rvdate' }); await say(ctx, 'Введіть дату у форматі ДД.ММ.РРРР:', cancelKb()); return; }
    }

    // --- виправити зміну ---
    if (k === 'fx') {
      if (!admin) return;
      if (a === 'emp') {
        const emp = E.byId(db, +b); if (!emp) return;
        const rows = S.recent(db, 7, emp.id);
        const kb = new InlineKeyboard();
        for (const s of rows) kb.text(`${S.line(s)}`.slice(0, 60), `fx:s:${s.id}`).row();
        kb.text('➕ Додати зміну вручну', `fx:new:${emp.id}`);
        await dropButtons(ctx);
        await say(ctx, `<b>${esc(emp.name)}</b> — останні зміни. Оберіть:`, kb);
        return;
      }
      if (a === 's') return showShift(ctx, +b);
      if (a === 'st' || a === 'en') {
        const s = S.byId(db, +b); if (!s) return;
        setFlow(uid, { name: 'fxtime', data: { id: s.id, which: a } });
        await say(ctx, `${a === 'st' ? 'Новий час початку' : 'Новий час кінця'} для зміни ${esc(S.line(s))} (${esc(s.name)}).\nВведіть ГГ:ХХ (та сама дата ${T.uaDate(s.date)}) або ДД.ММ.РРРР ГГ:ХХ:`, cancelKb());
        return;
      }
      if (a === 'now') {
        const r = S.edit(db, +b, { ended_at: T.iso(new Date()), note: 'закрито адміністратором' }, ctx.emp.id);
        await dropButtons(ctx);
        if (!r.ok) return say(ctx, `❌ ${r.reason}`);
        await say(ctx, `✅ Зміну закрито: ${esc(S.line(r.shift))}`);
        await notify.toGroup(`📝 ${esc(ctx.emp.name)} закрив(ла) зміну ${esc(r.shift.name)}: ${esc(S.line(r.shift))}`);
        return;
      }
      if (a === 'del') {
        const s = S.byId(db, +b); if (!s) return;
        await say(ctx, `Видалити зміну ${esc(s.name)} ${esc(S.line(s))}? Це вплине на зарплату.`, new InlineKeyboard().text('🗑 Так, видалити', `fx:delok:${s.id}`).text('❌ Ні', 'fx:cancel'));
        return;
      }
      if (a === 'delok') {
        const r = S.remove(db, +b, ctx.emp.id);
        await dropButtons(ctx);
        if (!r.ok) return say(ctx, `❌ ${r.reason}`);
        await say(ctx, `🗑 Зміну видалено: ${esc(r.shift.name)} ${esc(S.line(r.shift))}`);
        await notify.toGroup(`📝 ${esc(ctx.emp.name)} видалив(ла) зміну ${esc(r.shift.name)}: ${esc(S.line(r.shift))}`);
        return;
      }
      if (a === 'cancel') { await dropButtons(ctx); return; }
      if (a === 'new') {
        setFlow(uid, { name: 'fxnew', step: 'date', data: { empId: +b } });
        await say(ctx, 'Дата зміни (ДД.ММ.РРРР):', cancelKb());
        return;
      }
    }

    // --- працівники ---
    if (k === 'em') {
      if (!admin) return;
      if (a === 'v') return showEmployee(ctx, +b);
      if (a === 'add') { setFlow(uid, { name: 'emadd', step: 'name' }); await say(ctx, "Ім'я нового працівника:", cancelKb()); return; }
      if (a === 'pt') {
        if (!f || f.name !== 'emadd') return;
        f.data.pay_type = b; await dropButtons(ctx);
        if (b === 'none') { f.data.rate = 0; f.step = 'g'; await say(ctx, 'Як підписати кнопки?', new InlineKeyboard().text('Прийшла / Пішла', 'em:g:f').text('Прийшов / Пішов', 'em:g:m')); return; }
        f.step = 'rate';
        await say(ctx, b === 'daily' ? 'Ставка за робочий день, грн:' : 'Ставка за місяць, грн:', cancelKb());
        return;
      }
      if (a === 'g') {
        if (!f || f.name !== 'emadd') return;
        clearFlow(uid); await dropButtons(ctx);
        const emp = E.add(db, { name: f.data.name, pay_type: f.data.pay_type, rate: f.data.rate, gender: b }, ctx.emp.id);
        await say(ctx, `✅ Додано <b>${esc(emp.name)}</b> — ${E.payText(emp)}.`);
        return showEmployee(ctx, emp.id);
      }
      const emp = E.byId(db, +b); if (!emp) return;
      if (a === 'code') {
        const code = E.makeLinkCode(db, emp.id);
        await say(ctx, `Код прив'язки для <b>${esc(emp.name)}</b>: <code>${code}</code>\n\nПерешліть працівнику: відкрити бота @${botInfo ? botInfo.username : bot.botInfo.username}, натиснути Start і надіслати цей код. Код одноразовий.`);
        return;
      }
      if (a === 'tg') { setFlow(uid, { name: 'emtg', data: { id: emp.id } }); await say(ctx, `Введіть Telegram ID для <b>${esc(emp.name)}</b> (працівник бачить свій ID командою /id у боті):`, cancelKb()); return; }
      if (a === 'unlink') { E.unlink(db, emp.id, ctx.emp.id); await say(ctx, `🔓 Прив'язку ${esc(emp.name)} знято.`); return showEmployee(ctx, emp.id); }
      if (a === 'rate') {
        if (!E.isOwner(ctx.emp)) { await ctx.answerCallbackQuery({ text: 'Ставку змінює лише власник' }); return 'answered'; }
        setFlow(uid, { name: 'emrate', step: 'amount', data: { id: emp.id } });
        await say(ctx, `Нова ставка для <b>${esc(emp.name)}</b> (зараз ${E.payText(emp)}). Введіть число:`, cancelKb());
        return;
      }
      if (a === 'rateok') {
        if (!f || f.name !== 'emrate' || f.step !== 'confirm' || f.data.nonce !== c) { await ctx.answerCallbackQuery({ text: 'Уже виконано або скасовано' }); await dropButtons(ctx); return 'answered'; }
        clearFlow(uid); await dropButtons(ctx);
        E.setRate(db, emp.id, f.data.rate, ctx.emp.id);
        await say(ctx, `✅ Ставку ${esc(emp.name)} змінено: ${E.payText(E.byId(db, emp.id))}.`);
        await notify.toGroup(`⚙️ ${esc(ctx.emp.name)} змінив(ла) ставку ${esc(emp.name)}: ${E.payText(E.byId(db, emp.id))}`);
        return;
      }
      if (a === 'adm') {
        if (!E.isOwner(ctx.emp)) { await ctx.answerCallbackQuery({ text: 'Права змінює лише власник' }); return 'answered'; }
        if (emp.role === 'owner') return;
        E.setRole(db, emp.id, emp.role === 'admin' ? 'employee' : 'admin', ctx.emp.id);
        await say(ctx, `✅ ${esc(emp.name)} тепер ${E.roleText(E.byId(db, emp.id))}.`);
        return showEmployee(ctx, emp.id);
      }
      if (a === 'act') {
        if (emp.role === 'owner') return;
        E.setActive(db, emp.id, !emp.active, ctx.emp.id);
        await say(ctx, emp.active ? `🚫 ${esc(emp.name)} деактивовано (не входить у звіти).` : `✅ ${esc(emp.name)} знову активний.`);
        return showEmployee(ctx, emp.id);
      }
    }

    // --- зарплата / історія / місячний звіт ---
    if (k === 'sal') {
      if (!admin) return;
      if (a === 'e') return showSalary(ctx, +b, c || T.parts().month);
      if (a === 'h') { const emp = E.byId(db, +b); if (!emp) return; const rows = P.history(db, emp.id, 30); await say(ctx, `<b>${esc(emp.name)} — історія операцій</b>\n${rows.map((l) => '• ' + esc(P.ledgerLine(l))).join('\n') || '— операцій ще немає'}`); return; }
    }
    if (k === 'hs') {
      if (!admin) return;
      const rows = a === 'all' ? S.recent(db, 30) : S.recent(db, 30, +b);
      await say(ctx, `<b>Останні зміни</b>\n${rows.map((s) => `• ${esc(s.name)}: ${esc(S.line(s))}`).join('\n') || '— змін ще немає'}`);
      return;
    }
    if (k === 'mr') { if (!admin) return; return showMonthly(ctx, a); }

    // --- налаштування ---
    if (k === 'st') {
      if (!admin) return;
      if (a === 'time') { setFlow(uid, { name: 'sttime' }); await say(ctx, `Час щоденного підсумку (зараз ${scheduler.reportTime()}). Введіть ГГ:ХХ:`, cancelKb()); return; }
      if (a === 'backup') { const r = await scheduler.backupNow(); await say(ctx, r.ok ? '💾 Резервну копію надіслано власнику.' : `❌ Не вдалося: ${esc(r.reason || '')}`); return; }
      if (a === 'test') { const r = await notify.toGroup(`📣 Тестове повідомлення від ${esc(ctx.emp.name)}. Адмін-чат працює.`); await say(ctx, r.ok ? '✅ Доставлено в адмін-чат.' : `❌ Не доставлено: ${esc(r.reason || '')}`); return; }
      if (a === 'daily') { await say(ctx, scheduler.dailyReportText(T.parts().date)); return; }
    }
  }

  // ---------- екрани ----------
  async function showShift(ctx, id) {
    const s = S.byId(db, id); if (!s) return;
    const kb = new InlineKeyboard().text('🕘 Початок', `fx:st:${s.id}`).text('🕔 Кінець', `fx:en:${s.id}`).row();
    if (!s.ended_at) kb.text('✅ Закрити зараз', `fx:now:${s.id}`).row();
    kb.text('🗑 Видалити', `fx:del:${s.id}`);
    await dropButtons(ctx);
    await say(ctx, `<b>${esc(s.name)}</b>\n${esc(S.line(s))}${s.edit_note ? `\nПримітка: ${esc(s.edit_note)}` : ''}`, kb);
  }
  async function showEmployee(ctx, id) {
    const emp = E.byId(db, id); if (!emp) return;
    const p = T.parts().month;
    const s = P.summary(db, emp, p);
    const kb = new InlineKeyboard();
    if (emp.telegram_id) kb.text('🔓 Відв\'язати Telegram', `em:unlink:${emp.id}`).row();
    else kb.text('🔗 Код прив\'язки', `em:code:${emp.id}`).text('✏️ Ввести Telegram ID', `em:tg:${emp.id}`).row();
    if (emp.pay_type !== 'none') kb.text('💵 Змінити ставку', `em:rate:${emp.id}`).row();
    if (emp.role !== 'owner') kb.text(emp.role === 'admin' ? '👤 Зняти адміна' : '👑 Зробити адміном', `em:adm:${emp.id}`).text(emp.active ? '🚫 Деактивувати' : '✅ Активувати', `em:act:${emp.id}`);
    const lines = [
      `<b>${esc(emp.name)}</b> — ${E.roleText(emp)}${emp.active ? '' : ' · неактивний'}`,
      `Оплата: ${E.payText(emp)}`,
      `Telegram: ${emp.telegram_id ? `прив'язано (ID ${emp.telegram_id})` : '❌ не прив\'язано'}`,
    ];
    if (emp.pay_type !== 'none') lines.push(`${T.uaMonth(p)}: ${s.days != null ? `${s.days} дн · ` : ''}нараховано ${money(s.accrued)}, аванси ${money(s.advances)}, виплати ${money(s.payouts)}`, `Залишок до виплати: <b>${money(s.balance)}</b>`);
    await say(ctx, lines.join('\n'), kb);
  }
  async function showSalary(ctx, id, month) {
    const emp = E.byId(db, id); if (!emp) return;
    const s = P.summary(db, emp, month, T.parts().month);
    const kb = new InlineKeyboard().text('◀️', `sal:e:${id}:${T.addMonths(month, -1)}`).text('▶️', `sal:e:${id}:${T.addMonths(month, 1)}`).row().text('📅 Історія операцій', `sal:h:${id}`);
    await say(ctx, salaryText(emp, s), kb);
  }
  function salaryText(emp, s) {
    return [
      `<b>${esc(emp.name)}</b> — ${T.uaMonth(s.month)}`,
      `Оплата: ${E.payText(emp)}`,
      s.days != null ? `Робочих днів: <b>${s.days}</b>` : null,
      `Нараховано за місяць: <b>${money(s.accrued)}</b>`,
      `Аванси за місяць: ${money(s.advances)}`,
      `Виплати за місяць: ${money(s.payouts)}`,
      `\nУсього нараховано: ${money(s.totalAccrued)} · усього виплачено: ${money(s.totalPaid)}`,
      `<b>Залишок до виплати: ${money(s.balance)}</b>`,
    ].filter(Boolean).join('\n');
  }
  async function showMonthly(ctx, month) {
    const rep = P.monthlyReport(db, month, T.parts().month);
    const lines = [`📊 <b>Місячний звіт — ${T.uaMonth(month)}</b>`];
    for (const r of rep.rows) lines.push(`\n<b>${esc(r.emp.name)}</b> (${E.payText(r.emp)})${r.days != null ? ` · ${r.days} дн` : ''}\n  нараховано ${money(r.accrued)} · аванси ${money(r.advances)} · виплати ${money(r.payouts)}\n  залишок: <b>${money(r.balance)}</b>`);
    lines.push(`\n<b>Разом:</b> нараховано ${money(rep.total.accrued)} · аванси ${money(rep.total.advances)} · виплати ${money(rep.total.payouts)} · залишок ${money(rep.total.balance)}`);
    const reps = R.between(db, `${month}-01`, `${month}-31`);
    lines.push(`Звітів каси за місяць: ${reps.length}`);
    const kb = new InlineKeyboard().text('◀️', `mr:${T.addMonths(month, -1)}`).text('▶️', `mr:${T.addMonths(month, 1)}`);
    await say(ctx, lines.join('\n'), kb);
  }
  async function listReports(ctx, rows, title) {
    if (!rows.length) return say(ctx, `${esc(title)}: звітів немає.`);
    await say(ctx, `<b>${esc(title)}</b> — ${rows.length}`);
    for (const r of rows.slice(0, 10)) {
      const caption = esc(R.line(r));
      const kb = new InlineKeyboard().text('🤖 Аналізувати', `rp:ai:${r.id}`);
      try {
        if (r.kind === 'photo') await ctx.replyWithPhoto(r.file_id, { caption, reply_markup: kb });
        else if (r.kind === 'document') await ctx.replyWithDocument(r.file_id, { caption, reply_markup: kb });
        else await say(ctx, `${caption}\n${esc(r.comment || '')}`, kb);
      } catch (e) { await say(ctx, `${caption}\n(файл недоступний: ${esc(e.message)})`); }
    }
  }

  // ---------- відмітки ----------
  async function doStart(ctx) {
    const r = S.start(db, ctx.emp, new Date());
    if (r.dup) return menu(ctx, `Зміна вже відкрита з ${T.uaTime(r.shift.started_at)}. Щоб закрити — натисніть «${left(ctx.emp)}».`);
    const t = T.uaTime(r.shift.started_at);
    await menu(ctx, `✅ Прихід відмічено: <b>${t}</b>${r.outside ? '\n⚠️ Це поза графіком (' + S.scheduleText() + '). Час збережено, адміністратора повідомлено.' : ''}`);
    await notify.toGroup(`${r.outside ? '⚠️ Поза графіком · ' : ''}🟢 <b>${esc(ctx.emp.name)}</b> ${E.came(ctx.emp).toLowerCase()} ${t}`);
  }
  async function doEnd(ctx) {
    const r = S.end(db, ctx.emp, new Date());
    if (r.none) return menu(ctx, `Відкритої зміни немає. Спершу натисніть «${came(ctx.emp)}».`);
    const t = T.uaTime(r.shift.ended_at);
    await menu(ctx, `✅ Зміну закрито: <b>${T.uaTime(r.shift.started_at)}–${t}</b> (${T.durText(r.shift.started_at, r.shift.ended_at)})${r.outside ? '\n⚠️ Це поза графіком. Час збережено, адміністратора повідомлено.' : ''}`);
    await notify.toGroup(`${r.outside ? '⚠️ Поза графіком · ' : ''}🔴 <b>${esc(ctx.emp.name)}</b> ${E.left(ctx.emp).toLowerCase()} ${t} · ${T.durText(r.shift.started_at, r.shift.ended_at)}`);
  }
  async function myStats(ctx) {
    const p = T.parts(); const emp = ctx.emp;
    const rows = S.forEmployee(db, emp.id, `${p.month}-01`, `${p.month}-31`);
    const open = S.openShiftOf(db, emp.id);
    await menu(ctx, `<b>${esc(emp.name)} — ${T.uaMonth(p.month)}</b>\nРобочих днів: <b>${P.paidDays(db, emp.id, p.month)}</b>${open ? `\nЗараз на зміні з ${T.uaTime(open.started_at)}` : ''}\n\n${rows.map((s) => '• ' + esc(S.line(s))).join('\n') || 'Змін цього місяця ще немає.'}`);
  }
  async function mySalary(ctx) {
    const emp = ctx.emp;
    if (emp.pay_type === 'none') return menu(ctx, 'У власника зарплата 0 грн — облік не ведеться.');
    const s = P.summary(db, emp, T.parts().month);
    const hist = P.history(db, emp.id, 5);
    await menu(ctx, salaryText(emp, s) + (hist.length ? `\n\n<b>Останні операції</b>\n${hist.map((l) => '• ' + esc(P.ledgerLine(l))).join('\n')}` : ''));
  }

  // ---------- файли = звіт каси ----------
  async function saveReport(ctx, { kind, file_id, file_unique_id, file_name, mime, size, text }) {
    const p = T.parts();
    let local_path = null;
    if (file_id && (!size || size <= config.maxDownloadBytes)) {
      const safe = (file_name || `${kind}.jpg`).replace(/[^\w.\-Ѐ-ӿ]+/g, '_');
      const dest = path.join(config.dataDir, 'reports', p.date, `${file_unique_id || Date.now()}-${safe}`);
      try { local_path = await dl(file_id, dest); } catch (e) { console.error('download', e.message); }
    }
    const rep = R.add(db, { emp_id: ctx.emp.id, telegram_id: ctx.from.id, author: ctx.emp.name, date: p.date, kind, file_id, file_unique_id, file_name, mime, size, local_path, comment: text || ctx.message.caption || null });
    const kb = new InlineKeyboard().text('💬 Додати коментар', `rp:cm:${rep.id}`);
    if (ctx.isAdmin) kb.text('🤖 Аналізувати', `rp:ai:${rep.id}`);
    await say(ctx, `✅ Звіт каси <b>#${rep.id}</b> збережено\n${T.uaDateTime(rep.created_at)} · ${esc(rep.author)}${rep.comment ? `\nКоментар: ${esc(rep.comment)}` : ''}${file_id && !local_path && size > config.maxDownloadBytes ? '\n⚠️ Файл більший за 20 МБ — збережено лише посилання в Telegram.' : ''}`, kb);
    await menu(ctx, 'Дякую! Можна надіслати ще один файл або повернутись до меню.');
    const fwd = await notify.toGroup(`📸 Звіт каси #${rep.id} від ${esc(rep.author)} · ${T.uaDateTime(rep.created_at)}${rep.comment ? `\n${esc(rep.comment)}` : ''}`);
    if (fwd.ok && file_id) {
      try { if (kind === 'photo') await bot.api.sendPhoto(notify.groupId() || notify.ownerId(), file_id); else await bot.api.sendDocument(notify.groupId() || notify.ownerId(), file_id); } catch (_) { /* файл уже є в базі */ }
    }
    return rep;
  }

  bot.on(['message:photo', 'message:document'], async (ctx) => {
    if (!ctx.isPrivate) return;
    if (!ctx.emp) return notLinked(ctx);
    const f = flow(ctx.from.id);
    if (f && f.name === 'ai') {
      // фото в режимі AI = питання з фото
      const ph = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1] : null;
      const doc = ctx.message.document;
      const fileId = ph ? ph.file_id : doc.file_id;
      const dest = path.join(config.dataDir, 'tmp', `${Date.now()}-${(doc && doc.file_name) || 'photo.jpg'}`);
      let local = null; try { local = await dl(fileId, dest); } catch (_) { /* без файлу */ }
      const mime = ph ? 'image/jpeg' : doc.mime_type;
      await ctx.replyWithChatAction('typing').catch(() => {});
      let q = ctx.message.caption || 'Що на цьому зображенні / у цьому документі?';
      let attachment = null;
      if (local && isImage(mime, doc && doc.file_name)) attachment = { path: local, mime };
      else if (local) { const { extractText } = require('./extract'); const txt = await extractText(local, mime, doc && doc.file_name); q += txt ? `\n\nВміст документа:\n${txt}` : '\n\n(Документ не вдалося прочитати як текст.)'; }
      const r = await ai.ask(ctx.emp, q, { attachment });
      if (local) fs.rm(local, () => {});
      return say(ctx, esc(r.text), aiKb());
    }
    clearFlow(ctx.from.id);
    if (ctx.message.photo) {
      const ph = ctx.message.photo[ctx.message.photo.length - 1];
      return saveReport(ctx, { kind: 'photo', file_id: ph.file_id, file_unique_id: ph.file_unique_id, mime: 'image/jpeg', size: ph.file_size });
    }
    const doc = ctx.message.document;
    return saveReport(ctx, { kind: 'document', file_id: doc.file_id, file_unique_id: doc.file_unique_id, file_name: doc.file_name, mime: doc.mime_type, size: doc.file_size });
  });

  // ---------- текст: кнопки та кроки діалогів ----------
  bot.on('message:text', async (ctx) => {
    if (!ctx.isPrivate) return;
    const text = ctx.message.text.trim();
    const uid = ctx.from.id;
    if (!ctx.emp) {
      if (/^\d{6}$/.test(text)) return redeem(ctx, text);
      return notLinked(ctx);
    }
    let f = flow(uid);
    if (text === B.cancel || text === B.menu || text === B.exitAi) { clearFlow(uid); return menu(ctx, text === B.exitAi ? 'Режим AI вимкнено.' : 'Скасовано.'); }
    const isButton = Object.values(B).includes(text) || text === came(ctx.emp) || text === left(ctx.emp);
    if (f && f.name !== 'ai' && isButton && text !== B.skip && text !== B.noText) { clearFlow(uid); f = null; }
    if (f) return onFlowText(ctx, f, text);

    const e = ctx.emp;
    if (text === came(e)) return doStart(ctx);
    if (text === left(e)) return doEnd(ctx);
    if (text === B.stats) return myStats(ctx);
    if (text === B.salary) return mySalary(ctx);
    if (text === B.sendReport || text === B.cashReport) {
      setFlow(uid, { name: 'report' });
      return say(ctx, 'Надішліть фото касового звіту, PDF, Excel або просто текст. Підпис до файлу стане коментарем.', cancelKb());
    }
    if (text === B.ai) {
      setFlow(uid, { name: 'ai' }); ai.reset(uid);
      return say(ctx, '🤖 Запитайте що завгодно про бота, зміни, зарплату або звіти. Я лише читаю дані — змінити щось можна тільки кнопками адміністратора.', aiKb());
    }
    if (!ctx.isAdmin) return menu(ctx, 'Оберіть дію кнопкою нижче.');

    if (text === B.working) {
      const rows = S.working(db);
      return menu(ctx, `<b>Зараз працюють</b>\n${rows.map((s) => `• ${esc(s.name)} — з ${T.uaTime(s.started_at)} (${T.durText(s.started_at, new Date())})`).join('\n') || '— ніхто'}`);
    }
    if (text === B.employees) {
      const kb = new InlineKeyboard();
      for (const emp of E.list(db, { activeOnly: false })) kb.text(`${emp.active ? '' : '🚫 '}${emp.name} · ${E.payText(emp)}${emp.telegram_id ? '' : ' · ❌ TG'}`, `em:v:${emp.id}`).row();
      kb.text('➕ Додати працівника', 'em:add');
      return say(ctx, '<b>Працівники</b> — оберіть:', kb);
    }
    if (text === B.history) {
      const kb = new InlineKeyboard().text('Усі · останні 30', 'hs:all').row();
      for (const emp of E.list(db)) kb.text(emp.name, `hs:e:${emp.id}`);
      return say(ctx, '<b>Історія змін</b> — чиї?', kb);
    }
    if (text === B.payroll) {
      const kb = new InlineKeyboard();
      for (const emp of E.list(db).filter((x) => x.pay_type !== 'none')) kb.text(emp.name, `sal:e:${emp.id}:${T.parts().month}`).row();
      return say(ctx, '<b>Зарплата</b> — чия?', kb);
    }
    if (text === B.advance || text === B.payout) {
      const type = text === B.advance ? 'advance' : 'payout';
      setFlow(uid, { name: 'ledger', type, step: 'emp' });
      const kb = new InlineKeyboard();
      for (const emp of E.list(db).filter((x) => x.pay_type !== 'none')) kb.text(emp.name, `led:emp:${emp.id}`).row();
      kb.text(B.cancel, 'led:no');
      return say(ctx, `${type === 'advance' ? '➕ Аванс' : '💸 Виплата'} — кому?`, kb);
    }
    if (text === B.fixShift) {
      const kb = new InlineKeyboard();
      for (const emp of E.list(db)) kb.text(emp.name, `fx:emp:${emp.id}`).row();
      return say(ctx, '<b>Виправити зміну</b> — чию?', kb);
    }
    if (text === B.viewReports) {
      return say(ctx, '<b>Звіти каси</b>', new InlineKeyboard().text('📅 Сьогодні', 'rv:today').text('🕘 Останні 10', 'rv:recent').row().text('🔎 За датою', 'rv:date'));
    }
    if (text === B.monthly) return showMonthly(ctx, T.parts().month);
    if (text === B.alarm) {
      setFlow(uid, { name: 'alarm', step: 'confirm' });
      return say(ctx, '🚨 <b>Надіслати термінове повідомлення власнику та в адмін-чат?</b>', new InlineKeyboard().text('🚨 Так, надіслати', 'al:yes').text('❌ Ні', 'al:no'));
    }
    if (text === B.settings) {
      const u = ai.usage();
      const g = notify.groupId();
      const lines = [
        '<b>⚙️ Налаштування</b>',
        `Адмін-група: ${g ? `підключено (ID ${g})` : "❌ не підключено — додайте бота в групу і надішліть там /chatid"}`,
        `Власник: ${notify.ownerId() ? `ID ${notify.ownerId()}` : '❌ не прив\'язано'}`,
        `Щоденний підсумок: ${scheduler.reportTime()} (Київ)`,
        `Резервна копія бази: щодня о ${config.backupTime} власнику`,
        `Автозакриття зміни: через ${config.autoCloseHours} год`,
        `Графік: ${S.scheduleText()}`,
        `AI: ${u.model} · цього місяця ${u.calls} запитів, ≈ $${u.cost_usd.toFixed(2)} із ліміту $${u.limitUsd}`,
      ];
      return say(ctx, lines.join('\n'), new InlineKeyboard().text('🕘 Час підсумку', 'st:time').text('📊 Підсумок дня зараз', 'st:daily').row().text('💾 Копія зараз', 'st:backup').text('📣 Тест у групу', 'st:test'));
    }
    return menu(ctx, 'Оберіть дію кнопкою нижче.');
  });

  async function onFlowText(ctx, f, text) {
    const uid = ctx.from.id;
    if (f.name === 'ai') {
      await ctx.replyWithChatAction('typing').catch(() => {});
      const r = await ai.ask(ctx.emp, text);
      return say(ctx, esc(r.text), aiKb());
    }
    if (f.name === 'report') {
      clearFlow(uid);
      return saveReport(ctx, { kind: 'text', text });
    }
    if (f.name === 'rpcomment') {
      clearFlow(uid); R.setComment(db, f.data.id, text);
      return menu(ctx, `✅ Коментар до звіту #${f.data.id} збережено.`);
    }
    if (f.name === 'rvdate') {
      const d = T.parseDate(text); if (!d) return say(ctx, 'Не зрозумів дату. Формат: ДД.ММ.РРРР', cancelKb());
      clearFlow(uid); await menu(ctx, `Шукаю за ${T.uaDate(d)}…`);
      return listReports(ctx, R.onDate(db, d), `Звіти за ${T.uaDate(d)}`);
    }
    if (f.name === 'ledger') {
      if (f.step === 'amount') {
        const n = Number(text.replace(/\s/g, '').replace(',', '.'));
        if (!Number.isInteger(n) || n <= 0) return say(ctx, 'Введіть ціле число більше за 0, наприклад 1500:', cancelKb());
        f.data.amount = n; f.step = 'comment';
        return say(ctx, 'Коментар (за що / за який період), або Пропустити:', skipKb());
      }
      if (f.step === 'comment') {
        f.data.comment = text === B.skip ? null : text; f.step = 'confirm'; f.data.nonce = nonce();
        const label = f.type === 'advance' ? '➕ Аванс' : '💸 Виплата';
        return say(ctx, `${label}: <b>${money(f.data.amount)}</b> — <b>${esc(f.data.emp.name)}</b>${f.data.comment ? `\nКоментар: ${esc(f.data.comment)}` : ''}\n\nПідтвердити?`, new InlineKeyboard().text('✅ Підтвердити', `led:ok:${f.data.nonce}`).text('❌ Скасувати', 'led:no'));
      }
      return say(ctx, 'Оберіть працівника кнопкою вище або скасуйте.', cancelKb());
    }
    if (f.name === 'alarm') {
      if (f.step !== 'text') return say(ctx, 'Підтвердіть кнопкою вище або скасуйте.', cancelKb());
      clearFlow(uid);
      const msg = text === B.noText ? '' : text;
      return sendAlarm(ctx, msg);
    }
    if (f.name === 'fxtime') {
      const s = S.byId(db, f.data.id); if (!s) { clearFlow(uid); return menu(ctx, 'Зміну не знайдено.'); }
      const m = text.match(/^(?:(\d{2}\.\d{2}\.\d{4})\s+)?(\d{1,2}[:.]\d{2})$/);
      const date = m && m[1] ? T.parseDate(m[1]) : s.date; const time = m ? T.parseTime(m[2]) : null;
      if (!date || !time) return say(ctx, 'Формат: ГГ:ХХ або ДД.ММ.РРРР ГГ:ХХ', cancelKb());
      const iso = T.kyivToIso(date, time);
      const r = S.edit(db, s.id, f.data.which === 'st' ? { started_at: iso, note: 'виправлено адміністратором' } : { ended_at: iso, note: 'виправлено адміністратором' }, ctx.emp.id);
      if (!r.ok) return say(ctx, `❌ ${r.reason}`, cancelKb());
      clearFlow(uid);
      await menu(ctx, `✅ Зміну виправлено: ${esc(r.shift.name)} ${esc(S.line(r.shift))}`);
      return notify.toGroup(`📝 ${esc(ctx.emp.name)} виправив(ла) зміну ${esc(r.shift.name)}: ${esc(S.line(r.shift))}`);
    }
    if (f.name === 'fxnew') {
      if (f.step === 'date') { const d = T.parseDate(text); if (!d) return say(ctx, 'Формат: ДД.ММ.РРРР', cancelKb()); f.data.date = d; f.step = 'start'; return say(ctx, 'Час початку (ГГ:ХХ):', cancelKb()); }
      if (f.step === 'start') { const t = T.parseTime(text); if (!t) return say(ctx, 'Формат: ГГ:ХХ', cancelKb()); f.data.start = t; f.step = 'end'; return say(ctx, 'Час кінця (ГГ:ХХ) або Пропустити, щоб залишити зміну відкритою:', skipKb()); }
      if (f.step === 'end') {
        let endIso = null;
        if (text !== B.skip) { const t = T.parseTime(text); if (!t) return say(ctx, 'Формат: ГГ:ХХ або Пропустити', skipKb()); endIso = T.kyivToIso(f.data.date, t); if (endIso <= T.kyivToIso(f.data.date, f.data.start)) endIso = T.kyivToIso(T.addDays(f.data.date, 1), t); }
        const r = S.create(db, f.data.empId, T.kyivToIso(f.data.date, f.data.start), endIso, ctx.emp.id);
        if (!r.ok) return say(ctx, `❌ ${r.reason}`, cancelKb());
        clearFlow(uid);
        await menu(ctx, `✅ Зміну додано: ${esc(r.shift.name)} ${esc(S.line(r.shift))}`);
        return notify.toGroup(`📝 ${esc(ctx.emp.name)} додав(ла) зміну ${esc(r.shift.name)}: ${esc(S.line(r.shift))}`);
      }
    }
    if (f.name === 'emtg') {
      const id = Number(text); if (!Number.isInteger(id) || id <= 0) return say(ctx, 'Telegram ID — це число, наприклад 123456789:', cancelKb());
      clearFlow(uid);
      const r = E.link(db, f.data.id, id, ctx.emp.id);
      await menu(ctx, r.ok ? '✅ Прив\'язано.' : `❌ ${r.reason}`);
      return r.ok ? showEmployee(ctx, f.data.id) : undefined;
    }
    if (f.name === 'emrate') {
      if (f.step === 'amount') {
        const n = Number(text.replace(/\s/g, '')); if (!Number.isInteger(n) || n < 0) return say(ctx, 'Введіть ціле число:', cancelKb());
        f.data.rate = n; f.step = 'confirm'; f.data.nonce = nonce();
        const emp = E.byId(db, f.data.id);
        return say(ctx, `Змінити ставку <b>${esc(emp.name)}</b>: ${E.payText(emp)} → <b>${n} грн</b>?`, new InlineKeyboard().text('✅ Так', `em:rateok:${emp.id}:${f.data.nonce}`).text('❌ Ні', 'fx:cancel'));
      }
      return say(ctx, 'Підтвердіть кнопкою вище або скасуйте.', cancelKb());
    }
    if (f.name === 'emadd') {
      if (f.step === 'name') { if (text.length < 2) return say(ctx, "Ім'я закоротке:", cancelKb()); f.data.name = text; f.step = 'pt'; return say(ctx, 'Тип оплати:', new InlineKeyboard().text('За робочий день', 'em:pt:daily').text('За місяць', 'em:pt:monthly').row().text('Без зарплати (адміністратор)', 'em:pt:none')); }
      if (f.step === 'rate') { const n = Number(text.replace(/\s/g, '')); if (!Number.isInteger(n) || n < 0) return say(ctx, 'Введіть ціле число:', cancelKb()); f.data.rate = n; f.step = 'g'; return say(ctx, 'Як підписати кнопки?', new InlineKeyboard().text('Прийшла / Пішла', 'em:g:f').text('Прийшов / Пішов', 'em:g:m')); }
      return say(ctx, 'Оберіть кнопкою вище або скасуйте.', cancelKb());
    }
    if (f.name === 'sttime') {
      const t = T.parseTime(text); if (!t) return say(ctx, 'Формат: ГГ:ХХ, наприклад 22:30', cancelKb());
      clearFlow(uid); db.setting('daily_report_time', t); db.audit(ctx.emp.id, 'settings.daily_time', { t });
      return menu(ctx, `✅ Щоденний підсумок надсилатиметься о ${t}.`);
    }
    clearFlow(uid);
    return menu(ctx, 'Оберіть дію кнопкою нижче.');
  }

  async function sendAlarm(ctx, msg) {
    const p = T.parts();
    const body = `🚨🚨🚨 <b>ТЕРМІНОВО</b>\nВід: <b>${esc(ctx.emp.name)}</b>\n${T.uaDate(p.date)} ${p.time}\n${msg ? esc(msg) : '(без тексту)'}`;
    const ownerId = notify.ownerId(); const groupId = notify.groupId();
    const toOwner = ownerId && ownerId !== ctx.from.id ? await notify.send(ownerId, body) : (ownerId === ctx.from.id ? { ok: true, self: true } : { ok: false, reason: 'власника не прив\'язано' });
    const toGroup = groupId ? await notify.send(groupId, body) : { ok: false, reason: 'адмін-групу не підключено' };
    db.prepare('INSERT INTO alerts (admin_id, author, text, delivered_owner, delivered_group) VALUES (?, ?, ?, ?, ?)').run(ctx.emp.id, ctx.emp.name, msg, toOwner.ok ? 1 : 0, toGroup.ok ? 1 : 0);
    const lines = [
      toOwner.ok ? (toOwner.self ? '✅ Ви — власник, повідомлення записано' : '✅ Доставлено власнику') : `❌ Власнику НЕ доставлено: ${esc(toOwner.reason || 'помилка Telegram')}`,
      toGroup.ok ? '✅ Доставлено в адмін-чат' : `❌ В адмін-чат НЕ доставлено: ${esc(toGroup.reason || 'помилка Telegram')}`,
    ];
    if (!toOwner.ok && !toGroup.ok) lines.push('\n⚠️ Тривогу НЕ доставлено нікому. Зателефонуйте власнику.');
    await menu(ctx, lines.join('\n'));
  }

  bot.catch((err) => { console.error('bot error', err.error || err); });
  bot.flows = flows;
  return bot;
}

module.exports = { createBot, B, came, left };
