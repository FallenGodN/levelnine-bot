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

function createScheduler({ db, notify, api, now = () => new Date(), updater = null, restart = () => process.exit(0), updateEveryMin = 10 }) {
  const reportTime = () => T.parseTime(db.setting('daily_report_time')) || config.dailyReportTime;
  const sent = (key) => !!db.prepare('SELECT 1 FROM sent_log WHERE key = ?').get(key);
  const mark = (key) => db.prepare('INSERT OR IGNORE INTO sent_log (key) VALUES (?)').run(key);
  const addMin = (hhmm, m) => { const [h, mi] = hhmm.split(':').map(Number); const t = h * 60 + mi + m; return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

  /** Через годину після відкриття залу: хто з денних працівників ще не відмітився. Раз на день. */
  async function lateTick(when) {
    if (db.setting('late_alert') === '0') return false;
    const p = T.parts(when);
    const win = config.schedule[p.wd];
    if (!win || p.time < addMin(win[0], 60)) return false;
    const key = `late:${p.date}`;
    if (sent(key)) return false;
    const absent = E.list(db).filter((e) => e.pay_type === 'daily' && !S.onDate(db, p.date).some((s) => s.emp_id === e.id));
    if (absent.length) await notify.toGroup(`⏰ Зал відкрито з ${win[0]}, а ще не відмітились: ${absent.map((e) => esc(e.name)).join(', ')}`);
    mark(key);
    return absent.length > 0;
  }

  /** За годину до автозакриття — особисте нагадування працівнику. Раз на зміну. */
  async function remindTick(when) {
    const limit = new Date(when.getTime() - (config.autoCloseHours - 1) * 3600000).toISOString();
    const rows = db.prepare('SELECT s.*, e.name, e.telegram_id, e.gender FROM shifts s JOIN employees e ON e.id = s.emp_id WHERE s.ended_at IS NULL AND s.started_at <= ?').all(limit);
    const out = [];
    for (const s of rows) {
      const key = `remind:${s.id}`;
      if (sent(key)) continue;
      mark(key);
      if (!s.telegram_id) continue;
      const r = await notify.send(s.telegram_id, `⏳ Ви на зміні з ${T.uaTime(s.started_at)}. Не забудьте натиснути «🔴 ${E.left(s)}» — через годину бот закриє зміну автоматично.`);
      if (r.ok) out.push(s);
    }
    return out;
  }

  /** Автооновлення з GitHub: якщо є нові коміти — pull, npm install, перезапуск. */
  let lastUpdateCheck = 0;
  async function updateTick(when) {
    if (!updater) return false;
    if (when.getTime() - lastUpdateCheck < updateEveryMin * 60000) return false;
    lastUpdateCheck = when.getTime();
    const c = await updater.check();
    if (!c.ok || !c.behind) return false;
    const r = await updater.apply();
    if (!r.ok) { console.error('update failed', r.reason); return false; }
    await notify.toGroup(`🔄 Бот оновлено ${r.from} → ${r.to}${r.deps ? ' (оновлено залежності)' : ''}:\n${(r.changes || []).map((l) => '• ' + esc(l)).join('\n')}\nПерезапуск.`);
    setTimeout(restart, 800);
    return true;
  }

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
    if (!notify.ownerId()) return { ok: false, reason: 'власника ще не прив’язано' };
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
    const out = { closed: [], daily: false, backup: false, late: false, reminded: [], updated: false };
    try { out.reminded = await remindTick(when); } catch (e) { console.error('remind', e); }
    try { out.closed = await autoCloseTick(when); } catch (e) { console.error('autoClose', e); }
    try { out.late = await lateTick(when); } catch (e) { console.error('late', e); }
    try { out.daily = await dailyTick(when); } catch (e) { console.error('daily', e); }
    try { out.backup = await backupTick(when); } catch (e) { console.error('backup', e); }
    try { out.updated = await updateTick(when); } catch (e) { console.error('update', e); }
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
