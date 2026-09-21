'use strict';
// Уся логіка "який сьогодні день" рахується за київським часом.
const config = require('./config');

const fmtCache = {};
function fmt(tz) {
  if (!fmtCache[tz]) {
    fmtCache[tz] = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
  }
  return fmtCache[tz];
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Розкладає момент часу на київські складові. */
function parts(d = new Date(), tz = config.tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(d)) o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';
  return {
    y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second,
    wd: WD[o.weekday],
    date: `${o.year}-${o.month}-${o.day}`,
    time: `${o.hour}:${o.minute}`,
    month: `${o.year}-${o.month}`,
  };
}

/** Момент часу для київських дати й часу (враховує перехід на літній час). */
function fromKyiv(y, m, d, h = 0, mi = 0, tz = config.tz) {
  let guess = Date.UTC(y, m - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(guess), tz);
    const have = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    const want = Date.UTC(y, m - 1, d, h, mi);
    if (have === want) break;
    guess += want - have;
  }
  return new Date(guess);
}

function parseDate(s) {
  const t = String(s || '').trim();
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/) || t.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [y, mo, d] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]];
  const dt = fromKyiv(+y, +mo, +d, 12);
  if (parts(dt).date !== `${y}-${mo}-${d}`) return null;
  return `${y}-${mo}-${d}`;
}
function parseTime(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return `${String(+m[1]).padStart(2, '0')}:${m[2]}`;
}
/** "YYYY-MM-DD" + "HH:MM" (київські) → ISO UTC */
function kyivToIso(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return fromKyiv(y, m, d, h, mi).toISOString();
}

const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString();
const uaDate = (date) => { const [y, m, d] = date.split('-'); return `${d}.${m}.${y}`; };
const uaDateTime = (d) => { const p = parts(new Date(d)); return `${uaDate(p.date)} ${p.time}`; };
const uaTime = (d) => parts(new Date(d)).time;
const MONTHS = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
const WDS = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const uaMonth = (month) => { const [y, m] = month.split('-'); return `${MONTHS[+m - 1]} ${y}`; };
const addMonths = (month, n) => { const [y, m] = month.split('-').map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const addDays = (date, n) => { const [y, m, d] = date.split('-').map(Number); return parts(new Date(fromKyiv(y, m, d, 12).getTime() + n * 86400000)).date; };
const weekdayOf = (date) => { const [y, m, d] = date.split('-').map(Number); return parts(fromKyiv(y, m, d, 12)).wd; };

/** 1400 → «1 400 грн» (без залежності від ICU) */
const money = (n) => `${String(Math.trunc(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} грн`;

function hoursBetween(a, b) { return (new Date(b) - new Date(a)) / 3600000; }
function durText(a, b) {
  const min = Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
  return `${Math.floor(min / 60)} год ${String(min % 60).padStart(2, '0')} хв`;
}

module.exports = { parts, fromKyiv, parseDate, parseTime, kyivToIso, iso, uaDate, uaDateTime, uaTime, uaMonth, addMonths, addDays, weekdayOf, hoursBetween, durText, WDS, money };
