'use strict';
// Серверний планувальник: автозакриття, щоденний звіт, резервна копія. Працює без браузера.
const path = require('path');
const fs = require('fs');
const config = require('./config');
const T = require('./time');
const E = require('./employees');
const S = require('./shifts');
const P = require('./payroll');
const R = require('./reports');
const { esc } = require('./notify');

function dailyReportText(db, date) {
  const shifts = S.onDate(db, date);
  const emps = E.list(db).filter((e) => e.pay_type !== 'none');
  const came = shifts.map((s) => `• ${esc(s.name)} — ${T.uaTime(s.started_at)}${s.ended_at ? '–' + T.uaTime(s.ended_at) : ' (ще працює)'}${s.auto_closed ? ' · автозакрито' : ''}`);
  const cameIds = new Set(shifts.map((s) => s.emp_id));
  const absent = emps.filter((e) => !cameIds.has(e.id)).map((e) => `• ${esc(e.name)}`);
  const working = S.working(db).map((s) => `• ${esc(s.name)} з ${T.uaDateTime(s.started_at)}`);
  const auto = shifts.filter((s) => s.auto_closed).map((s) => `• ${esc(s.name)} — ${T.uaTime(s.started_at)}–${T.uaTime(s.ended_at)}`);
  const reports = R.onDate(db, date);
  const warn = shifts.filter((s) => s.start_outside || s.end_outside).map((s) => `• ${esc(s.name)} — відмітка поза графіком (${T.uaTime(s.started_at)}${s.ended_at ? '–' + T.uaTime(s.ended_at) : ''})`);
  const unlinked = emps.filter((e) => !e.telegram_id).map((e) => `• ${esc(e.name)} не прив'язаний до Telegram`);
  const wd = T.WDS[T.weekdayOf(date)];
  return [
    `📊 <b>Підсумок дня ${T.uaDate(date)} (${wd})</b>`,
    `\n<b>Прийшли:</b>\n${came.join('\n') || '— ніхто'}`,
    `\n<b>Не відмітились:</b>\n${absent.join('\n') || '— усі відмітились'}`,
    `\n<b>Зараз працюють:</b>\n${working.join('\n') || '— ніхто'}`,
    `\n<b>Автоматично закриті зміни:</b>\n${auto.join('\n') || '— немає'}`,
    `\n<b>Нараховано за день:</b> ${T.money(P.dayAccrued(db, date))}`,
    `\n<b>Звіти каси:</b> ${reports.length ? reports.map((r) => esc(R.line(r))).join('\n') : '— не отримано'}`,
    `\n<b>Попередження:</b>\n${[...warn, ...unlinked].join('\n') || '— немає'}`,
  ].join('\n');
}

function createScheduler({ db, notify, api, now = () => new Date() }) {
  const reportTime = () => T.parseTime(db.setting('daily_report_time')) || config.dailyReportTime;

  async function autoCloseTick(when) {
    const closed = S.autoClose(db, when);
    for (const s of closed) {
      await notify.toGroup(`⏱ <b>${esc(s.name)}</b> — зміну закрито автоматично через ${config.autoCloseHours} год\n${T.uaTime(s.started_at)}–${T.uaTime(s.ended_at)} (${T.uaDate(s.date)})`);
    }
    return closed;
  }

  async function dailyTick(when) {
    const p = T.parts(when);
    if (p.time < reportTime()) return false;
    const key = `daily:${p.date}`;
    if (db.prepare('SELECT 1 FROM sent_log WHERE key = ?').get(key)) return false;
    const text = dailyReportText(db, p.date);
    const results = [await notify.toGroup(text), ...(await notify.toAdmins(text))];
    if (results.some((r) => r.ok)) db.prepare('INSERT OR IGNORE INTO sent_log (key) VALUES (?)').run(key);
    return true;
  }

  async function backupTick(when) {
    const p = T.parts(when);
    if (p.time < config.backupTime) return false;
    const key = `backup:${p.date}`;
    if (db.prepare('SELECT 1 FROM sent_log WHERE key = ?').get(key)) return false;
    const r = await backupNow();
    if (r.ok) db.prepare('INSERT OR IGNORE INTO sent_log (key) VALUES (?)').run(key);
    return r.ok;
  }

  async function backupNow() {
    if (!db.file || db.file === ':memory:') return { ok: false, reason: 'memory db' };
    const dir = path.join(config.dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const p = T.parts(now());
    const file = path.join(dir, `levelnine-${p.date}.sqlite`);
    await db.backup(file);
    // тримаємо 14 останніх копій на диску
    const old = fs.readdirSync(dir).filter((f) => f.endsWith('.sqlite')).sort().slice(0, -14);
    for (const f of old) fs.unlinkSync(path.join(dir, f));
    const { InputFile } = require('grammy');
    return notify.document(notify.ownerId(), new InputFile(file), `💾 Резервна копія бази за ${T.uaDate(p.date)}. Збережіть цей файл — з нього можна відновити все.`);
  }

  async function tick(when = now()) {
    const out = { closed: [], daily: false, backup: false };
    try { out.closed = await autoCloseTick(when); } catch (e) { console.error('autoClose', e); }
    try { out.daily = await dailyTick(when); } catch (e) { console.error('daily', e); }
    try { out.backup = await backupTick(when); } catch (e) { console.error('backup', e); }
    return out;
  }

  let timer = null;
  function start() {
    tick().catch(() => {});
    timer = setInterval(() => tick().catch(() => {}), 60 * 1000);
    return timer;
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { tick, start, stop, backupNow, dailyReportText: (date) => dailyReportText(db, date), reportTime };
}

module.exports = { createScheduler, dailyReportText };
