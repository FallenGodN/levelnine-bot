'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee',      -- employee | admin | owner
  pay_type TEXT NOT NULL DEFAULT 'daily',     -- daily | monthly | none
  rate INTEGER NOT NULL DEFAULT 0,            -- грн за день або за місяць
  gender TEXT NOT NULL DEFAULT 'f',           -- f | m — для підписів кнопок
  telegram_id INTEGER UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  link_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  emp_id INTEGER NOT NULL REFERENCES employees(id),
  date TEXT NOT NULL,                         -- київська дата початку
  started_at TEXT NOT NULL,
  ended_at TEXT,
  auto_closed INTEGER NOT NULL DEFAULT 0,
  start_outside INTEGER NOT NULL DEFAULT 0,
  end_outside INTEGER NOT NULL DEFAULT 0,
  edited_by INTEGER,
  edit_note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON shifts(emp_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS shifts_date ON shifts(date);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  emp_id INTEGER NOT NULL REFERENCES employees(id),
  type TEXT NOT NULL,                         -- advance | payout
  amount INTEGER NOT NULL,
  comment TEXT,
  admin_id INTEGER,
  idem_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  emp_id INTEGER,
  telegram_id INTEGER,
  author TEXT,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,                         -- photo | document | text
  file_id TEXT,
  file_unique_id TEXT,
  file_name TEXT,
  mime TEXT,
  size INTEGER,
  local_path TEXT,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS reports_date ON reports(date);
CREATE TABLE IF NOT EXISTS sent_log (
  key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  admin_id INTEGER,
  author TEXT,
  text TEXT,
  delivered_owner INTEGER NOT NULL DEFAULT 0,
  delivered_group INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS ai_usage (
  month TEXT PRIMARY KEY,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

const SEED = [
  { name: 'Юлія', role: 'employee', pay_type: 'daily', rate: config.dailyRate, gender: 'f' },
  { name: 'Ірина', role: 'employee', pay_type: 'daily', rate: config.dailyRate, gender: 'f' },
  { name: 'Прибиральник', role: 'employee', pay_type: 'monthly', rate: config.cleanerMonthly, gender: 'm' },
  { name: 'Власник', role: 'owner', pay_type: 'none', rate: 0, gender: 'm' },
];

function open(file) {
  const dbFile = file || path.join(config.dataDir, 'levelnine.sqlite');
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  if (db.prepare('SELECT COUNT(*) c FROM employees').get().c === 0) {
    const ins = db.prepare('INSERT INTO employees (name, role, pay_type, rate, gender) VALUES (@name, @role, @pay_type, @rate, @gender)');
    for (const e of SEED) ins.run(e);
  }
  if (config.ownerTelegramId) {
    const taken = db.prepare('SELECT id FROM employees WHERE telegram_id = ?').get(config.ownerTelegramId);
    if (!taken) db.prepare("UPDATE employees SET telegram_id = ? WHERE role = 'owner' AND telegram_id IS NULL").run(config.ownerTelegramId);
  }
  db.file = dbFile;
  db.setting = (k, v) => {
    if (v === undefined) { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : null; }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v === null ? null : String(v));
  };
  db.audit = (actor_id, action, details) => db.prepare('INSERT INTO audit (actor_id, action, details) VALUES (?, ?, ?)').run(actor_id || null, action, details ? JSON.stringify(details) : null);
  return db;
}

module.exports = { open, SEED };
