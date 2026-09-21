'use strict';
// Усі секрети — лише зі змінних оточення (Railway → Variables, або .env локально).
const path = require('path');
const fs = require('fs');

function loadDotEnv() {
  const p = path.join(process.cwd(), '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

const config = {
  botToken: env('BOT_TOKEN', ''),
  openaiKey: env('OPENAI_API_KEY', ''),
  openaiModel: env('OPENAI_MODEL', 'gpt-4.1-mini'),
  openaiMonthlyLimitUsd: Number(env('OPENAI_MONTHLY_LIMIT_USD', 10)),
  ownerTelegramId: Number(env('OWNER_TELEGRAM_ID', 0)) || 0,
  adminChatId: Number(env('ADMIN_CHAT_ID', 0)) || 0,
  dailyReportTime: env('DAILY_REPORT_TIME', '22:30'),
  backupTime: env('BACKUP_TIME', '03:30'),
  dataDir: path.resolve(env('DATA_DIR', './data')),
  tz: env('TZ_NAME', 'Europe/Kyiv'),
  // Правила спортзалу
  autoCloseHours: 10,
  dailyRate: 1400,
  cleanerMonthly: 12000,
  // Графік контролю присутності: 0 = неділя … 6 = субота
  schedule: {
    1: ['08:00', '22:00'], 2: ['08:00', '22:00'], 3: ['08:00', '22:00'],
    4: ['08:00', '22:00'], 5: ['08:00', '22:00'],
    6: ['09:00', '18:00'],
    0: ['09:00', '16:00'],
  },
  maxDownloadBytes: 20 * 1024 * 1024, // ліміт Bot API на завантаження файлів
};

module.exports = config;
