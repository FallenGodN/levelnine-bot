'use strict';
const config = require('./config');
const { open } = require('./db');
const { createNotifier } = require('./notify');
const { createScheduler } = require('./scheduler');
const { createBot } = require('./bot');

async function main() {
  if (!config.botToken) {
    console.error('BOT_TOKEN не задано. Додайте його у Variables (Railway) або у файл .env');
    process.exit(1);
  }
  const db = open();
  console.log('db:', db.file);
  const deps = {};
  const bot = createBot({ token: config.botToken, db, deps });
  const notify = createNotifier({ api: bot.api, db });
  const { createUpdater } = require('./updater');
  const updater = createUpdater();
  const restart = () => { console.log('restarting for update'); scheduler.stop(); bot.stop().catch(() => {}); db.close(); process.exit(0); };
  const scheduler = createScheduler({ db, notify, api: bot.api, updater, restart });
  Object.assign(deps, { notify, scheduler, updater, restart });
  updater.version().then((v) => console.log('version:', v.text)).catch(() => {});

  await bot.api.setMyCommands([
    { command: 'start', description: 'Головне меню' },
    { command: 'menu', description: 'Показати кнопки та підказку' },
    { command: 'id', description: 'Мій Telegram ID' },
    { command: 'chatid', description: 'ID цього чату (для адмін-групи)' },
  ]).catch((e) => console.error('setMyCommands', e.message));

  scheduler.start();
  const stop = async () => { scheduler.stop(); await bot.stop(); db.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

  console.log('bot starting (long polling)…');
  await bot.start({
    drop_pending_updates: false,
    onStart: (info) => console.log(`@${info.username} працює. Група: ${notify.groupId() || 'не задано'}, власник: ${notify.ownerId() || 'не задано'}`),
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
