'use strict';
// Автооновлення з GitHub: перевірка кожні N хвилин, git pull, npm install, перезапуск.
// Код лежить у git; папка data/ не відстежується, тому база й файли переживають оновлення.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

function run(cmd, args, { cwd = ROOT, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, shell: isWin && /npm/.test(cmd) }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(String(stdout).trim());
    });
  });
}

function createUpdater({ exec = run, root = ROOT, branch = 'main', log = console } = {}) {
  let cachedVersion = null;
  const hasGit = () => fs.existsSync(path.join(root, '.git'));

  async function version() {
    if (cachedVersion) return cachedVersion;
    try {
      const out = await exec('git', ['log', '-1', '--format=%h|%cs|%s'], { cwd: root });
      const [h, d, s] = out.split('|');
      cachedVersion = { hash: h, date: d, subject: s, text: `${h} · ${d}` };
    } catch (_) {
      cachedVersion = { hash: 'dev', date: '', subject: '', text: 'dev (без git)' };
    }
    return cachedVersion;
  }

  /** Чи є нові коміти на origin. */
  async function check() {
    if (!hasGit()) return { ok: false, reason: 'папка не є git-репозиторієм' };
    try {
      await exec('git', ['fetch', '--quiet', 'origin', branch], { cwd: root });
      const local = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
      const remote = await exec('git', ['rev-parse', `origin/${branch}`], { cwd: root });
      const behind = local !== remote;
      const changes = behind ? await exec('git', ['log', '--oneline', `HEAD..origin/${branch}`], { cwd: root }) : '';
      return { ok: true, behind, local: local.slice(0, 7), remote: remote.slice(0, 7), changes: changes.split('\n').filter(Boolean) };
    } catch (e) {
      return { ok: false, reason: (e.stderr || e.message || '').trim().split('\n')[0] || 'git недоступний' };
    }
  }

  /** git pull + npm install (якщо змінились залежності). Повертає {ok, from, to, deps}. */
  async function apply() {
    const before = await check();
    if (!before.ok) return before;
    if (!before.behind) return { ok: true, updated: false, version: before.local };
    try {
      const lockBefore = fs.existsSync(path.join(root, 'package-lock.json')) ? fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8') : '';
      await exec('git', ['pull', '--ff-only', '--quiet', 'origin', branch], { cwd: root });
      const lockAfter = fs.existsSync(path.join(root, 'package-lock.json')) ? fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8') : '';
      let deps = false;
      if (lockBefore !== lockAfter) {
        deps = true;
        await exec(isWin ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: root, timeout: 600000 });
      }
      cachedVersion = null;
      const v = await version();
      log.log(`updated ${before.local} → ${v.hash}${deps ? ' (+deps)' : ''}`);
      return { ok: true, updated: true, from: before.local, to: v.hash, deps, changes: before.changes };
    } catch (e) {
      return { ok: false, reason: (e.stderr || e.message || '').trim().split('\n')[0] || 'помилка оновлення' };
    }
  }

  return { version, check, apply, run: exec, root };
}

module.exports = { createUpdater, run };
