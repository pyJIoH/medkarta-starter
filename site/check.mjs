#!/usr/bin/env node
// Проверка данных медкарты: форматы, ссылки между файлами, полнота описаний.
// Запуск: npm run check. Ошибки — то, из-за чего сайт покажет данные неверно; их нужно исправить.
// Предупреждения — стоит посмотреть. Код выхода 1, если есть ошибки.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { APP_ROOT, resolveDataRoot } from './root.mjs';

// Данные карты: по умолчанию рядом с сайтом; вынесенные — через --root или MEDKARTA_ROOT.
const ROOT = resolveDataRoot();
const errors = [];
const warnings = [];
const err = (where, text) => errors.push(`${where}: ${text}`);
const warn = (where, text) => warnings.push(`${where}: ${text}`);

const TYPES = new Set(['labs', 'imaging', 'visit', 'treatment', 'note', 'summary']);
const STATUSES = new Set(['ok', 'watch', 'action']);
const KINDS = new Set(['symptom', 'condition', 'finding', 'goal']);
const PRIORITIES = new Set(['high', 'medium', 'low']);
const PLAN_KINDS = new Set(['labs', 'visit', 'task', 'vaccine', 'screening']);
const FLAGS = new Set(['', 'H', 'L', 'A']);
const METRIC_COLUMNS = 'date,test,value,unit,ref_low,ref_high,flag,category,test_original,lab,record,comment';
const EPISODE_COLUMNS = 'date,case,duration,severity,before,helped,note';
const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOOSE_DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const rel = (file) => path.relative(ROOT, file);
const exists = (file) => fs.existsSync(file);
const read = (file) => (exists(file) ? fs.readFileSync(file, 'utf8').replace(/^﻿/, '') : null);
const str = (v) => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
const list = (v) => (Array.isArray(v) ? v.map(str) : v == null || v === '' ? [] : [str(v)]);

function frontmatter(file) {
  const text = read(file);
  const m = text?.match(FRONTMATTER);
  if (!m) {
    err(rel(file), 'нет frontmatter (блок между --- в начале файла)');
    return null;
  }
  try {
    const doc = YAML.parseDocument(m[1]);
    if (doc.errors.length) throw doc.errors[0];
    return { meta: doc.toJS() ?? {}, body: text.slice(m[0].length) };
  } catch (e) {
    err(rel(file), `frontmatter не читается как YAML — ${String(e.message).split('\n')[0]}. Значения с «: » нужно брать в кавычки`);
    return null;
  }
}

/** CSV с кавычками → массив объектов по заголовку. */
function parseCsv(file, columns) {
  const text = read(file);
  if (text == null) {
    err(rel(file), 'файл не найден');
    return [];
  }
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') (row.push(cell), (cell = ''));
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) (row.push(cell), rows.push(row));
  const lines = rows.filter((r) => r.some((c) => c !== ''));
  if (!lines.length) {
    err(rel(file), 'пустой файл — должна быть хотя бы строка заголовка');
    return [];
  }
  const header = lines[0];
  if (columns && header.join(',') !== columns) err(rel(file), `заголовок должен быть «${columns}»`);
  return lines.slice(1).map((cells, i) => {
    if (cells.length !== header.length) err(`${rel(file)}, строка ${i + 2}`, `колонок ${cells.length}, а в заголовке ${header.length}`);
    return Object.fromEntries(header.map((name, k) => [name, cells[k] ?? '']));
  });
}

/** Относительные ссылки в markdown должны вести на существующие файлы. */
function checkLinks(file, body) {
  for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1].split('#')[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    let decoded = target;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      // оставляем как есть
    }
    if (!exists(path.resolve(path.dirname(file), decoded))) warn(rel(file), `ссылка ведёт в никуда: ${target}`);
  }
}

// ---------- записи ----------

const records = new Map(); // id → meta
const recordsDir = path.join(ROOT, 'records');
if (exists(recordsDir)) {
  for (const year of fs.readdirSync(recordsDir)) {
    const yearDir = path.join(recordsDir, year);
    if (!fs.statSync(yearDir).isDirectory()) continue;
    for (const name of fs.readdirSync(yearDir)) {
      const dir = path.join(yearDir, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const id = `${year}/${name}`;
      const where = `records/${id}`;
      const file = path.join(dir, 'report.md');
      if (!exists(file)) {
        err(where, 'в папке записи нет report.md');
        continue;
      }
      const m = name.match(/^(\d{4}-\d{2}-\d{2})_([a-z]+)_([a-z0-9-]+)$/);
      if (!m) err(where, 'имя папки должно быть YYYY-MM-DD_<type>_<slug> латиницей');
      const fm = frontmatter(file);
      if (!fm) continue;
      const meta = fm.meta;
      records.set(id, meta);
      const date = str(meta.date);
      if (!str(meta.title)) err(where, 'нет title');
      if (!FULL_DATE.test(date)) err(where, `date должна быть YYYY-MM-DD, сейчас «${date}»`);
      if (!TYPES.has(meta.type)) err(where, `type «${str(meta.type)}» — допустимы: ${[...TYPES].join(', ')}`);
      if (!STATUSES.has(meta.status)) err(where, `status «${str(meta.status)}» — допустимы: ok, watch, action`);
      if (!str(meta.summary)) warn(where, 'нет summary — на сайте запись будет без пояснения');
      if (m) {
        if (m[1] !== date) err(where, `дата в имени папки (${m[1]}) не совпадает с date (${date})`);
        if (m[2] !== meta.type) err(where, `тип в имени папки (${m[2]}) не совпадает с type (${str(meta.type)})`);
        if (!date.startsWith(year)) err(where, `запись лежит в папке ${year}, а дата — ${date}`);
      }
      if (meta.type === 'summary') {
        if (!Array.isArray(meta.systems) || !meta.systems.length) warn(where, 'в сводке нет списка systems — на главной не будет состояния по системам');
        for (const s of meta.systems ?? []) {
          if (!str(s?.name)) err(where, 'в systems есть пункт без name');
          if (!STATUSES.has(s?.status)) err(where, `systems → «${str(s?.name)}»: status должен быть ok, watch или action`);
        }
      }
      checkLinks(file, fm.body);
    }
  }
}

// ---------- кейсы ----------

const cases = new Map();
const casesDir = path.join(ROOT, 'cases');
if (exists(casesDir)) {
  for (const name of fs.readdirSync(casesDir)) {
    if (!name.endsWith('.md')) continue;
    const id = name.slice(0, -3);
    const where = `cases/${name}`;
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id)) err(where, 'имя файла — латиницей, kebab-case');
    const fm = frontmatter(path.join(casesDir, name));
    if (!fm) continue;
    const meta = fm.meta;
    cases.set(id, meta);
    if (!str(meta.title)) err(where, 'нет title');
    if (!KINDS.has(meta.kind)) err(where, `kind «${str(meta.kind)}» — допустимы: ${[...KINDS].join(', ')}`);
    if (!['open', 'closed'].includes(meta.state)) err(where, 'state должен быть open или closed');
    if (!STATUSES.has(meta.status)) err(where, 'status должен быть ok, watch или action');
    if (meta.priority != null && !PRIORITIES.has(meta.priority)) err(where, 'priority должен быть high, medium или low');
    if (meta.priority == null) warn(where, 'нет priority — сайт покажет «средний»');
    if (!LOOSE_DATE.test(str(meta.opened))) err(where, `opened должна быть YYYY, YYYY-MM или YYYY-MM-DD, сейчас «${str(meta.opened)}»`);
    if (!str(meta.summary)) warn(where, 'нет summary');
    if (meta.state === 'closed') {
      if (!str(meta.resolution)) warn(where, 'кейс закрыт, но нет resolution — чем закончилось');
      if (meta.closed != null && !FULL_DATE.test(str(meta.closed))) err(where, 'closed должна быть YYYY-MM-DD');
    } else if (!str(meta.next)) warn(where, 'нет next — следующего шага');
    if (meta.kind === 'goal' && !(meta.goal?.metric && Number.isFinite(Number(meta.goal?.target)))) {
      err(where, 'у цели должен быть блок goal с metric и числовым target');
    }
    checkLinks(path.join(casesDir, name), fm.body);
  }
}

// ---------- показатели ----------

const tests = new Map(); // название → дата последнего замера
let metricRows = 0;
for (const name of ['labs.csv', 'vitals.csv']) {
  const file = path.join(ROOT, 'metrics', name);
  parseCsv(file, METRIC_COLUMNS).forEach((r, i) => {
    const where = `metrics/${name}, строка ${i + 2}`;
    metricRows++;
    if (!FULL_DATE.test(r.date)) err(where, `date должна быть YYYY-MM-DD, сейчас «${r.date}»`);
    if (!r.test) err(where, 'нет названия показателя (test)');
    if (r.value === '') err(where, `у «${r.test}» пустое значение`);
    if (!FLAGS.has(r.flag)) err(where, `flag «${r.flag}» — допустимы H, L, A или пусто`);
    if (!r.category) warn(where, `у «${r.test}» нет категории`);
    if (r.record && !records.has(r.record)) err(where, `record «${r.record}» — такой записи нет`);
    for (const col of ['ref_low', 'ref_high']) {
      if (r[col] !== '' && !Number.isFinite(Number(r[col]))) err(where, `${col} должен быть числом, сейчас «${r[col]}» — текстовый референс пишем в comment`);
    }
    if (/^-?\d+,\d+$/.test(r.value)) err(where, `значение «${r.value}» — десятичный разделитель должен быть точкой`);
    if (r.test && (!tests.has(r.test) || tests.get(r.test) < r.date)) tests.set(r.test, r.date);
  });
}

// Один показатель — одна единица и одна категория.
{
  const seen = new Map();
  for (const name of ['labs.csv', 'vitals.csv']) {
    for (const r of parseCsvQuiet(path.join(ROOT, 'metrics', name))) {
      const s = seen.get(r.test) ?? { units: new Set(), cats: new Set() };
      if (r.unit) s.units.add(r.unit);
      if (r.category) s.cats.add(r.category);
      seen.set(r.test, s);
    }
  }
  for (const [test, s] of seen) {
    if (s.units.size > 1) warn('metrics', `у «${test}» разные единицы: ${[...s.units].join(', ')} — привести к одной`);
    if (s.cats.size > 1) warn('metrics', `у «${test}» разные категории: ${[...s.cats].join(', ')}`);
  }
}

function parseCsvQuiet(file) {
  const before = errors.length;
  const rows = parseCsv(file);
  errors.length = before; // эти ошибки уже записаны при первом чтении
  return rows;
}

// Словарь названий: каждое каноническое имя должно быть в aliases.csv.
{
  const file = path.join(ROOT, 'metrics', 'aliases.csv');
  if (exists(file)) {
    const known = new Set(parseCsv(file, 'source_name,test,category').map((r) => r.test));
    for (const r of parseCsvQuiet(path.join(ROOT, 'metrics', 'labs.csv'))) {
      if (r.test && !known.has(r.test)) {
        warn('metrics/aliases.csv', `нет соответствия для «${r.test}» (в бланке: «${r.test_original}»)`);
        known.add(r.test);
      }
    }
  }
}

// Эпизоды.
{
  const file = path.join(ROOT, 'metrics', 'episodes.csv');
  if (exists(file)) {
    parseCsv(file, EPISODE_COLUMNS).forEach((r, i) => {
      const where = `metrics/episodes.csv, строка ${i + 2}`;
      if (!FULL_DATE.test(r.date)) err(where, 'date должна быть YYYY-MM-DD');
      if (!cases.has(r.case)) err(where, `кейса «${r.case}» нет`);
      if (r.severity !== '' && !(Number(r.severity) >= 0 && Number(r.severity) <= 10)) err(where, 'severity — число от 0 до 10 или пусто');
    });
  }
}

// Закреплённые показатели.
{
  const text = read(path.join(ROOT, 'metrics', 'pinned.json'));
  if (text != null) {
    try {
      const pinned = JSON.parse(text);
      if (!Array.isArray(pinned)) throw new Error('не массив');
      for (const name of pinned) if (!tests.has(name)) warn('metrics/pinned.json', `закреплён «${name}», но такого показателя нет`);
    } catch (e) {
      err('metrics/pinned.json', `должен быть JSON-массив названий — ${e.message}`);
    }
  }
}

// Описания показателей: у каждого показателя — запись.
{
  const file = path.join(ROOT, 'metrics', 'descriptions.yaml');
  const text = read(file);
  let items = [];
  if (text != null) {
    try {
      items = YAML.parse(text) ?? [];
      if (!Array.isArray(items)) throw new Error('должен быть список');
    } catch (e) {
      err('metrics/descriptions.yaml', `не читается как YAML — ${String(e.message).split('\n')[0]}`);
      items = [];
    }
  }
  const described = new Map();
  for (const item of items) {
    const name = str(item?.test);
    if (!name) {
      err('metrics/descriptions.yaml', 'есть запись без test');
      continue;
    }
    if (described.has(name)) err('metrics/descriptions.yaml', `«${name}» описан дважды`);
    described.set(name, item);
    if (!str(item.about)) warn('metrics/descriptions.yaml', `у «${name}» нет about`);
    if (item.status != null && !STATUSES.has(item.status)) err('metrics/descriptions.yaml', `у «${name}» status должен быть ok, watch или action`);
    if (!tests.has(name)) warn('metrics/descriptions.yaml', `«${name}» описан, но значений нет`);
    else if (!str(item.assessment)) warn('metrics/descriptions.yaml', `у «${name}» нет assessment — оценки`);
    else if (str(item.as_of) < tests.get(name)) warn('metrics/descriptions.yaml', `оценка «${name}» устарела: as_of ${str(item.as_of) || '—'}, последний замер ${tests.get(name)}`);
  }
  for (const name of tests.keys()) if (!described.has(name)) err('metrics/descriptions.yaml', `нет описания для «${name}»`);
}

// ---------- ссылки из кейсов, сводок и плана ----------

for (const [id, meta] of cases) {
  for (const r of list(meta.records)) if (!records.has(r)) err(`cases/${id}.md`, `records → «${r}» — такой записи нет`);
  for (const t of list(meta.metrics)) if (!tests.has(t)) warn(`cases/${id}.md`, `metrics → «${t}» — такого показателя нет в CSV`);
  if (meta.goal?.metric && !tests.has(str(meta.goal.metric))) warn(`cases/${id}.md`, `goal → показателя «${meta.goal.metric}» пока нет в CSV`);
}
for (const [id, meta] of records) {
  for (const s of meta.systems ?? []) {
    if (s?.case && !cases.has(str(s.case))) err(`records/${id}`, `systems → «${s.name}»: кейса «${s.case}» нет`);
    if (s?.record && !records.has(str(s.record))) err(`records/${id}`, `systems → «${s.name}»: записи «${s.record}» нет`);
  }
}

let planCount = 0;
{
  const text = read(path.join(ROOT, 'plan.yaml'));
  if (text != null) {
    let items = [];
    try {
      items = YAML.parse(text) ?? [];
      if (!Array.isArray(items)) throw new Error('должен быть список');
    } catch (e) {
      err('plan.yaml', `не читается как YAML — ${String(e.message).split('\n')[0]}`);
    }
    const ids = new Set();
    for (const item of items) {
      planCount++;
      const where = `plan.yaml → ${str(item?.id) || '(без id)'}`;
      if (!str(item?.id)) err(where, 'нет id');
      if (ids.has(str(item?.id))) err(where, 'id повторяется');
      ids.add(str(item?.id));
      if (!str(item?.title)) err(where, 'нет title');
      if (!LOOSE_DATE.test(str(item?.date))) err(where, `date должна быть YYYY, YYYY-MM или YYYY-MM-DD, сейчас «${str(item?.date)}»`);
      if (item?.kind != null && !PLAN_KINDS.has(item.kind)) err(where, `kind «${item.kind}» — допустимы: ${[...PLAN_KINDS].join(', ')}`);
      if (item?.case && !cases.has(str(item.case))) err(where, `кейса «${item.case}» нет`);
      if (item?.record && !records.has(str(item.record))) err(where, `записи «${item.record}» нет`);
    }
  }
}

// ---------- профиль ----------

let profileNote = '';
{
  const file = path.join(ROOT, 'profile.md');
  if (!exists(file)) err('profile.md', 'файл не найден');
  else {
    const fm = frontmatter(file);
    if (fm) {
      if (!str(fm.meta.name)) profileNote = 'профиль не заполнен — настройка ещё не пройдена';
      else {
        if (!FULL_DATE.test(str(fm.meta.born))) warn('profile.md', 'born — дата рождения YYYY-MM-DD: без неё сайт не посчитает возраст');
        if (!Number.isFinite(Number(fm.meta.height_cm)) || !fm.meta.height_cm) warn('profile.md', 'нет height_cm — сайт не посчитает ИМТ');
      }
      checkLinks(file, fm.body);
    }
  }
}

// ---------- настройки сайта ----------

{
  const text = read(path.join(ROOT, 'settings.yaml'));
  if (text != null) {
    let s;
    try {
      s = YAML.parse(text);
    } catch (e) {
      err('settings.yaml', `не читается как YAML: ${e.message.split('\n')[0]}`);
    }
    if (s != null && (typeof s !== 'object' || Array.isArray(s))) err('settings.yaml', 'ожидаются поля assistant и labs');
    else if (s) {
      if (s.assistant != null && typeof s.assistant !== 'string') err('settings.yaml', 'assistant — строка: как сайт называет ассистента');
      if (s.labs != null && (typeof s.labs !== 'object' || Array.isArray(s.labs))) err('settings.yaml', 'labs — пары «название лаборатории: короткое название»');
    }
  }
}

// ---------- итог ----------

console.log('Проверка медкарты');
if (ROOT !== APP_ROOT) console.log(`  данные: ${ROOT}`);
console.log(`  записей ${records.size} · кейсов ${cases.size} · показателей ${tests.size} (${metricRows} значений) · пунктов плана ${planCount}`);
if (profileNote) console.log(`  ${profileNote}`);
if (errors.length) {
  console.log(`\nОшибки — ${errors.length}:`);
  for (const e of errors) console.log(`  ✗ ${e}`);
}
if (warnings.length) {
  console.log(`\nПредупреждения — ${warnings.length}:`);
  for (const w of warnings) console.log(`  ! ${w}`);
}
if (!errors.length && !warnings.length) console.log('\nВсё в порядке.');
else if (!errors.length) console.log('\nОшибок нет.');
process.exit(errors.length ? 1 : 0);
