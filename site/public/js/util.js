// Общие мелочи: DOM, экранирование, даты, числа, иконки, словари.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const enc = encodeURIComponent;

/** 1 эпизод / 2 эпизода / 5 эпизодов */
export function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
export const count = (n, forms) => `${n} ${plural(n, forms)}`;

// ---------- даты (поддерживаются неполные: YYYY и YYYY-MM) ----------

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
export const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export function dateParts(d) {
  const m = String(d ?? '').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!m) return null;
  return { y: Number(m[1]), m: m[2] ? Number(m[2]) : null, d: m[3] ? Number(m[3]) : null };
}

/** Начало периода как Date (локальная полночь). */
export function toDate(d) {
  const p = dateParts(d);
  return p ? new Date(p.y, (p.m ?? 1) - 1, p.d ?? 1) : null;
}

/** Конец периода: для «2026-12» — 31 декабря. Нужен, чтобы понять, просрочено ли. */
export function endOfPeriod(d) {
  const p = dateParts(d);
  if (!p) return null;
  if (p.d) return new Date(p.y, p.m - 1, p.d);
  if (p.m) return new Date(p.y, p.m, 0);
  return new Date(p.y, 11, 31);
}

export function fmtDate(d, style = 'long') {
  const p = dateParts(d);
  if (!p) return d ? String(d) : '—';
  if (!p.m) return String(p.y);
  if (!p.d) return `${(style === 'long' ? MONTHS_NOM : MONTHS_SHORT)[p.m - 1]} ${p.y}`;
  if (style === 'long') return `${p.d} ${MONTHS_GEN[p.m - 1]} ${p.y}`;
  return `${p.d} ${p.m === 5 ? 'мая' : MONTHS_SHORT[p.m - 1]} ${p.y}`;
}

const DAY = 86_400_000;

/** «5 мес. назад», «через 3 нед.» — относительно сегодняшней даты. */
export function relTime(d, today) {
  const a = toDate(d);
  const b = toDate(today);
  if (!a || !b) return '';
  const days = Math.round((a - b) / DAY);
  const n = Math.abs(days);
  let text;
  if (n === 0) return 'сегодня';
  if (n === 1) return days < 0 ? 'вчера' : 'завтра';
  if (n < 14) text = count(n, ['день', 'дня', 'дней']);
  else if (n < 60) text = `${Math.round(n / 7)} нед.`;
  else if (n < 730) text = `${Math.round(n / 30.4)} мес.`;
  else {
    // «2 года 7 мес.», а не округление до «3 лет»; дальше пяти лет месяцы уже не важны
    const months = Math.round(n / 30.44);
    const years = Math.floor(months / 12);
    const rest = months % 12;
    text = years >= 5 ? count(Math.round(months / 12), ['год', 'года', 'лет']) : `${count(years, ['год', 'года', 'лет'])}${rest ? ` ${rest} мес.` : ''}`;
  }
  return days < 0 ? `${text} назад` : `через ${text}`;
}

/** Для дат без дня («2026-12») и без месяца: «в этом месяце», «в следующем месяце», иначе как обычно. */
export function relPeriod(d, today) {
  const p = dateParts(d);
  const t = dateParts(today);
  if (!p || !t) return '';
  if (p.d) return relTime(d, today);
  if (!p.m) return p.y === t.y ? 'в этом году' : relTime(d, today);
  const diff = (p.y - t.y) * 12 + (p.m - t.m);
  if (diff === 0) return 'в этом месяце';
  if (diff === 1) return 'в следующем месяце';
  return relTime(d, today);
}

export function age(born, today) {
  const b = dateParts(born);
  const t = dateParts(today);
  if (!b?.d || !t?.d) return null;
  return t.y - b.y - (t.m < b.m || (t.m === b.m && t.d < b.d) ? 1 : 0);
}

// ---------- числа ----------

export function num(s) {
  if (s === '' || s == null) return NaN;
  const n = Number(String(s).replace(',', '.'));
  return Number.isNaN(n) ? NaN : n;
}

export const fmtNum = (v, digits = 2) => String(+v.toFixed(digits));

/** Знаковая разница: «+5», «−0.3». Минус — типографский. */
export function fmtDelta(d) {
  const a = Math.abs(d);
  const text = fmtNum(a, a >= 100 ? 0 : a >= 10 ? 1 : 2);
  if (Number(text) === 0) return '0';
  return `${d > 0 ? '+' : '−'}${text}`;
}

// ---------- словари ----------

export const TYPES = {
  summary: { label: 'Сводки', one: 'Сводка', icon: 'summary' },
  labs: { label: 'Анализы', one: 'Анализы', icon: 'flask' },
  visit: { label: 'Визиты', one: 'Визит', icon: 'visit' },
  imaging: { label: 'Снимки', one: 'Снимок', icon: 'imaging' },
  treatment: { label: 'Лечение', one: 'Лечение', icon: 'pill' },
  note: { label: 'Заметки', one: 'Заметка', icon: 'note' },
  symptom: { label: 'Симптомы', one: 'Симптом', icon: 'zap' },
};

export const STATUS = {
  ok: 'в норме',
  watch: 'наблюдать',
  action: 'нужно действие',
};
export const STATUS_RANK = { action: 0, watch: 1, ok: 2 };

// Приоритет кейса — насколько он важен владельцу; от него зависит порядок в списках.
export const PRIORITY = { high: 'Высокий', medium: 'Средний', low: 'Низкий' };
export const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

export const CASE_KINDS = {
  symptom: 'Симптом',
  condition: 'Состояние',
  finding: 'Находка в анализах',
  goal: 'Цель',
};

export const PLAN_KINDS = {
  labs: { label: 'Анализы', icon: 'flask' },
  visit: { label: 'Визит', icon: 'visit' },
  task: { label: 'Задача', icon: 'check' },
  vaccine: { label: 'Прививка', icon: 'shield' },
  screening: { label: 'Скрининг', icon: 'search' },
};

export const FLAGS = {
  H: { mark: '↑', label: 'выше нормы' },
  L: { mark: '↓', label: 'ниже нормы' },
  A: { mark: '!', label: 'отклонение' },
};

// ---------- иконки (свои, штриховые, 24×24) ----------

const ICONS = {
  home: '<path d="M4 10.5 12 4l8 6.5V20H4z"/><path d="M10 20v-5h4v5"/>',
  cases: '<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 4.5v-1h6v1"/><path d="M9 10.5h6M9 14.5h6"/>',
  pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  records: '<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4"/><path d="M10 12h5M10 16h5"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="15" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.6-3.4 3.4-5.5 7-5.5s6.4 2.1 7 5.5"/>',
  inbox: '<path d="M4 13.5 6.5 5h11L20 13.5V19H4z"/><path d="M4 13.5h4.5l1 2.5h5l1-2.5H20"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  upload: '<path d="M12 15.5v-11M7.5 9 12 4.5 16.5 9"/><path d="M5 15.5v4h14v-4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  star: '<path d="m12 4 2.4 5 5.4.7-4 3.8 1 5.4-4.8-2.6-4.8 2.6 1-5.4-4-3.8 5.4-.7z"/>',
  check: '<path d="m5.5 12.5 4 4 9-9.5"/>',
  chevron: '<path d="m9.5 6 6 6-6 6"/>',
  x: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  flask: '<path d="M9.5 3.5h5M10.5 3.5v6L5.6 18a1.7 1.7 0 0 0 1.5 2.5h9.8a1.7 1.7 0 0 0 1.5-2.5l-4.9-8.5v-6"/><path d="M8 15h8"/>',
  visit: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M12 8.5v7M8.5 12h7"/>',
  note: '<path d="M5 4.5h14v10l-5 5H5z"/><path d="M14 19.5v-5h5"/>',
  imaging: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10.5" r="1.8"/><path d="m20.5 15.5-4.5-4-7 7"/>',
  pill: '<rect x="2.5" y="8.5" width="19" height="7" rx="3.5" transform="rotate(-45 12 12)"/><path d="m9.5 9.5 5 5"/>',
  summary: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M8 9h8M8 12.5h8M8 16h5"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  list: '<path d="M9 6.5h10.5M9 12h10.5M9 17.5h10.5"/><path d="M4.75 6.5h.5M4.75 12h.5M4.75 17.5h.5"/>',
  table: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 10h17M3.5 14.5h17M9.5 5v14"/>',
  theme: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6z"/><path d="m9 12 2.2 2.2L15 10.4"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  zap: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  file: '<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.6" fill="currentColor"/>',
};

export function icon(name, size = 18, cls = '') {
  return `<svg class="icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}

// Статус: цвет + форма (круг / ромб / треугольник), чтобы различалось не только цветом.
const STATUS_SHAPES = {
  ok: '<circle cx="12" cy="12" r="9" fill="var(--good)"/><path d="m8 12.3 2.7 2.7L16 9.6" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  watch:
    '<rect x="5" y="5" width="14" height="14" rx="2.5" transform="rotate(45 12 12)" fill="var(--warn)"/><circle cx="12" cy="12" r="2.4" fill="#0b0b0b"/>',
  action:
    '<path d="M12 4 21 19.5H3z" fill="var(--crit)" stroke="var(--crit)" stroke-width="2.4" stroke-linejoin="round"/><path d="M12 9.5v4.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.2" fill="#fff"/>',
  closed:
    '<circle cx="12" cy="12" r="8.2" fill="none" stroke="var(--muted)" stroke-width="1.8"/><path d="m8.3 12.3 2.5 2.5 5-5.2" stroke="var(--muted)" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
};

/** Приоритет: три столбика, закрашено 3 / 2 / 1 — читается без цвета. */
export function priorityIcon(priority, size = 14) {
  const filled = 3 - (PRIORITY_RANK[priority] ?? 1);
  const bars = [
    [3.5, 14, 6],
    [10, 9, 11],
    [16.5, 4, 16],
  ].map(([x, y, h], i) => `<rect x="${x}" y="${y}" width="4" height="${h}" rx="1.2"${i < filled ? '' : ' opacity=".22"'}/>`);
  return `<svg class="prio-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${bars.join('')}</svg>`;
}

export function statusIcon(status, size = 16) {
  return `<svg class="status-icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${STATUS_SHAPES[status] ?? STATUS_SHAPES.watch}</svg>`;
}
