'use strict';
// Excel-експорт місяця: підсумок, усі зміни, аванси й виплати. Для бухгалтера / власника.
const XLSX = require('xlsx');
const T = require('./time');
const E = require('./employees');
const S = require('./shifts');
const P = require('./payroll');
const R = require('./reports');

function monthWorkbook(db, month, nowMonth = month) {
  const rep = P.monthlyReport(db, month, nowMonth);
  const summary = [['Працівник', 'Оплата', 'Робочих днів', 'Нараховано', 'Аванси', 'Виплати', 'Залишок до виплати']];
  for (const r of rep.rows) summary.push([r.emp.name, E.payText(r.emp), r.days == null ? '' : r.days, r.accrued, r.advances, r.payouts, r.balance]);
  summary.push(['Разом', '', '', rep.total.accrued, rep.total.advances, rep.total.payouts, rep.total.balance]);

  const shifts = [['Дата', 'Працівник', 'Початок', 'Кінець', 'Тривалість', 'Автозакрито', 'Поза графіком', 'Виправлено']];
  const rows = db.prepare('SELECT s.*, e.name FROM shifts s JOIN employees e ON e.id = s.emp_id WHERE s.date LIKE ? ORDER BY s.started_at').all(`${month}-%`);
  for (const s of rows) shifts.push([T.uaDate(s.date), s.name, T.uaTime(s.started_at), s.ended_at ? T.uaTime(s.ended_at) : '', s.ended_at ? T.durText(s.started_at, s.ended_at) : '', s.auto_closed ? 'так' : '', s.start_outside || s.end_outside ? 'так' : '', s.edited_by ? 'так' : '']);

  const ledger = [['Дата', 'Працівник', 'Тип', 'Сума', 'Коментар', 'Додав']];
  const ops = db.prepare("SELECT l.*, e.name, a.name admin_name FROM ledger l JOIN employees e ON e.id = l.emp_id LEFT JOIN employees a ON a.id = l.admin_id WHERE substr(l.created_at,1,7) = ? ORDER BY l.created_at").all(month);
  for (const l of ops) ledger.push([T.uaDateTime(l.created_at), l.name, l.type === 'advance' ? 'аванс' : 'виплата', l.amount, l.comment || '', l.admin_name || '']);

  const reports = [['Дата і час', 'Автор', 'Тип', 'Файл', 'Коментар']];
  for (const r of R.between(db, `${month}-01`, `${month}-31`).reverse()) reports.push([T.uaDateTime(r.created_at), r.author || '', r.kind, r.file_name || '', r.comment || '']);

  const wb = XLSX.utils.book_new();
  const add = (name, aoa, widths) => { const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = widths.map((w) => ({ wch: w })); XLSX.utils.book_append_sheet(wb, ws, name); };
  add('Підсумок', summary, [18, 16, 14, 14, 12, 12, 20]);
  add('Зміни', shifts, [12, 16, 9, 9, 16, 12, 14, 12]);
  add('Аванси і виплати', ledger, [18, 16, 10, 10, 30, 14]);
  add('Звіти каси', reports, [18, 14, 10, 24, 40]);
  return wb;
}

function monthXlsx(db, month, nowMonth) {
  const wb = monthWorkbook(db, month, nowMonth);
  return { name: `LEVEL_NINE_${month}.xlsx`, buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) };
}

module.exports = { monthWorkbook, monthXlsx };
