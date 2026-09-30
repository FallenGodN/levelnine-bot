'use strict';
// Надсилання в адмін-групу та власнику. Кожен результат чесний: ok лише коли Telegram підтвердив.
const config = require('./config');
const E = require('./employees');

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function createNotifier({ api, db }) {
  const groupId = () => Number(db.setting('admin_chat_id') || config.adminChatId) || 0;
  const ownerId = () => { const o = E.owner(db); return (o && o.telegram_id) || config.ownerTelegramId || 0; };

  async function send(chatId, text, extra = {}) {
    if (!chatId) return { ok: false, reason: 'no chat id' };
    try {
      const m = await api.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });
      return { ok: !!(m && m.message_id), message: m };
    } catch (e) {
      console.error('notify failed', chatId, e && e.message);
      return { ok: false, reason: e && e.message };
    }
  }
  /** У групу; якщо групи немає — власнику, щоб нічого не губилось. */
  async function toGroup(text, extra) {
    const g = groupId();
    if (g) return send(g, text, extra);
    return send(ownerId(), text, extra);
  }
  const toOwner = (text, extra) => send(ownerId(), text, extra);
  /** Подія для власника: у групу (якщо є) І власнику особисто (якщо він не автор). */
  async function event(text, { actorTgId = null, extra } = {}) {
    const out = [];
    const g = groupId(); const o = ownerId();
    if (g) out.push(await send(g, text, extra));
    if (o && o !== actorTgId) out.push(await send(o, text, extra));
    if (!g && !o) out.push({ ok: false, reason: 'no chat id' });
    return out;
  }
  /** Копія медіа (фото/відео/документ) у ті самі чати. */
  async function eventMedia(kind, fileId, caption, { actorTgId = null } = {}) {
    const targets = [groupId(), ownerId()].filter((id, i, a) => id && a.indexOf(id) === i && id !== actorTgId);
    for (const id of targets) {
      try {
        if (kind === 'photo') await api.sendPhoto(id, fileId, { caption });
        else if (kind === 'video') await api.sendVideo(id, fileId, { caption });
        else if (kind === 'document') await api.sendDocument(id, fileId, { caption });
      } catch (e) { console.error('eventMedia', id, e && e.message); }
    }
  }
  /** Усім адміністраторам приватно (без дублювання власнику, якщо він у списку). */
  async function toAdmins(text, extra) {
    const ids = new Set(E.admins(db).map((a) => a.telegram_id));
    if (ownerId()) ids.add(ownerId());
    const out = [];
    for (const id of ids) out.push(await send(id, text, extra));
    return out;
  }
  async function document(chatId, file, caption) {
    try {
      const m = await api.sendDocument(chatId, file, { caption, parse_mode: 'HTML' });
      return { ok: !!(m && m.message_id) };
    } catch (e) { console.error('document failed', e && e.message); return { ok: false, reason: e && e.message }; }
  }

  return { send, toGroup, toOwner, toAdmins, event, eventMedia, document, groupId, ownerId, esc };
}

module.exports = { createNotifier, esc };
