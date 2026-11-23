// Данные сайта: один запрос /api/state на навигацию + производная модель показателей.

import { num, toDate, STATUS_RANK, PRIORITY_RANK } from './util.js';

export const store = {
  data: null,
  tests: new Map(), // название показателя → { name, category, unit, list, last, prev, flag, points }
  loadedAt: 0,
};

export async function api(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { 'X-Medkarta': '1', ...(opts.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/** Как сайт называет ассистента: имя из settings.yaml (не склоняется) или слово «ассистент» в нужном падеже. */
const WHO = { nom: 'ассистент', gen: 'ассистента', dat: 'ассистенту' };
export function who(form = 'nom', capital = false) {
  const name = store.data?.settings?.assistant;
  if (name) return name;
  const word = WHO[form] ?? WHO.nom;
  return capital ? word[0].toUpperCase() + word.slice(1) : word;
}

export const post = (url, body) =>
  api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** maxAge — не перезапрашивать, если данные свежее (мс): для мелких переходов вроде открытия панели. */
export async function refresh(maxAge = 0) {
  if (store.data && Date.now() - store.loadedAt < maxAge) return store.data;
  store.data = await api('/api/state');
  store.loadedAt = Date.now();
  store.tests = buildTests(store.data.metrics);
  initSeen();
  return store.data;
}

// ---------- показатели ----------

/** Флаг как в источнике (H/L/A); если его нет — считаем по референсу из бланка. */
export function rowFlag(r) {
  if (r.flag) return r.flag;
  const v = num(r.value);
  if (v < num(r.ref_low)) return 'L';
  if (v > num(r.ref_high)) return 'H';
  return '';
}

export function refText(r) {
  if (r.ref_low && r.ref_high) return `${r.ref_low} – ${r.ref_high}`;
  if (r.ref_high) return `до ${r.ref_high}`;
  if (r.ref_low) return `от ${r.ref_low}`;
  return '';
}

function buildTests(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!r.test) continue;
    if (!groups.has(r.test)) groups.set(r.test, []);
    groups.get(r.test).push(r);
  }
  const tests = new Map();
  for (const [name, list] of groups) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const last = list.at(-1);
    const points = list
      .map((row) => ({ t: +toDate(row.date), v: num(row.value), row, flag: rowFlag(row) }))
      .filter((p) => Number.isFinite(p.v) && Number.isFinite(p.t));
    // Предыдущее числовое значение — для «изменения»; только если последнее тоже число.
    const prev = points.length >= 2 && points.at(-1).row === last ? points.at(-2) : null;
    tests.set(name, {
      name,
      category: last.category || 'Прочее',
      unit: last.unit,
      list,
      last,
      prev,
      delta: prev ? points.at(-1).v - prev.v : null,
      flag: rowFlag(last),
      points,
    });
  }
  return tests;
}

export const CATEGORY_ORDER = [
  'Липиды и сердце', 'Обмен веществ', 'Печень и белки', 'Почки', 'Электролиты и минералы',
  'Общий анализ крови', 'Лейкоцитарная формула', 'Витамины и нутриенты', 'Гормоны', 'Щитовидная железа',
  'Простата', 'Женское здоровье', 'Поджелудочная', 'Иммунитет и инфекции', 'Токсины', 'Моча', 'Замеры', 'Прочее',
];
const catRank = (c) => (CATEGORY_ORDER.indexOf(c) + 1 || 99);

export function categories(tests) {
  return [...new Set(tests.map((t) => t.category))].sort((a, b) => catRank(a) - catRank(b));
}

/** Показатели, у которых последний замер вне нормы (замеры с приёмов без референсов не считаем). */
export function flaggedTests() {
  return [...store.tests.values()]
    .filter((t) => t.flag)
    .sort((a, b) => b.last.date.localeCompare(a.last.date) || a.name.localeCompare(b.name, 'ru'));
}

export const isPinned = (name) => store.data.pinned.includes(name);

/** Строки показателей, пришедшие из конкретной записи (анализа или визита). */
export const rowsOfRecord = (id) => store.data.metrics.filter((r) => r.record === id);

// ---------- кейсы, записи, план ----------

/**
 * Активные — по приоритету, внутри него по статусу и давности; «нужно действие» всегда сверху,
 * каким бы ни был приоритет. Закрытые — свежие первыми.
 */
export function sortedCases(state) {
  const urgent = (c) => (c.status === 'action' ? 0 : 1);
  return store.data.cases
    .filter((c) => c.state === state)
    .sort((a, b) =>
      state === 'open'
        ? urgent(a) - urgent(b) ||
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
          a.opened.localeCompare(b.opened)
        : (b.closed || b.opened).localeCompare(a.closed || a.opened),
    );
}

export const caseById = (id) => store.data.cases.find((c) => c.id === id);
export const recordById = (id) => store.data.records.find((r) => r.id === id);
export const casesForTest = (name) => store.data.cases.filter((c) => c.metrics.includes(name));
export const casesForRecord = (id) => store.data.cases.filter((c) => c.records.includes(id));

/**
 * Цель кейса в цифрах: где сейчас, сколько пройдено и сколько осталось.
 * Работает в обе стороны — и «снизить до», и «поднять до».
 */
export function goalState(c) {
  const g = c?.goal;
  if (!g) return null;
  const test = store.tests.get(g.metric);
  const last = test?.points.at(-1);
  if (!last) return { case: c, ...g, unit: test?.unit ?? '', current: null };
  const start = g.start ?? test.points[0].v;
  const total = start - g.target;
  const reached = total >= 0 ? last.v <= g.target : last.v >= g.target;
  return {
    case: c,
    metric: g.metric,
    target: g.target,
    start,
    start_date: g.start_date,
    unit: test.unit,
    current: last.v,
    date: last.row.date,
    done: Math.abs(start - last.v),
    total: Math.abs(total),
    pct: total === 0 ? 1 : Math.min(1, Math.max(0, (start - last.v) / total)),
    remaining: reached ? 0 : Math.abs(last.v - g.target),
    reached,
  };
}

/** Цель по показателю — из открытого кейса, у которого она задана. */
export function goalFor(name) {
  return goalState(store.data.cases.find((c) => c.state === 'open' && c.goal?.metric === name));
}

export function episodesOf(caseId) {
  return store.data.episodes.filter((e) => e.case === caseId).sort((a, b) => b.date.localeCompare(a.date));
}

/** Невыполненные пункты плана, ближайшие первыми. */
export function upcomingPlan() {
  return store.data.plan.filter((p) => !p.done).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- «новое»: какие записи уже открывались в этом браузере ----------

const SEEN_KEY = 'medkarta.seen';
let seen = new Set();

function initSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (raw == null) {
      // Первый запуск: всё, что уже есть, считаем прочитанным.
      seen = new Set(store.data.records.map((r) => r.id));
      localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
    } else {
      seen = new Set(JSON.parse(raw));
    }
  } catch {
    seen = new Set(store.data.records.map((r) => r.id));
  }
}

export const isNew = (id) => !seen.has(id);

export function markSeen(id) {
  if (seen.has(id)) return;
  seen.add(id);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // приватный режим — не страшно
  }
}
