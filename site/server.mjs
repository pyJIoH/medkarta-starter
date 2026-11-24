// Локальный сервер медкарты. Без фреймворков: node:http + marked + yaml.
// Слушает только 127.0.0.1 — наружу ничего не торчит.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Marked } from 'marked';
import YAML from 'yaml';
import { APP_ROOT, resolveDataRoot } from './root.mjs';

// ROOT — данные карты (их можно вынести: --root или MEDKARTA_ROOT), APP_ROOT — сам сайт.
const ROOT = resolveDataRoot();
const DIR = {
  public: path.join(APP_ROOT, 'site', 'public'),
  records: path.join(ROOT, 'records'),
  cases: path.join(ROOT, 'cases'),
  inbox: path.join(ROOT, 'inbox'),
};
const FILES = {
  profile: path.join(ROOT, 'profile.md'),
  plan: path.join(ROOT, 'plan.yaml'),
  pinned: path.join(ROOT, 'metrics', 'pinned.json'),
  episodes: path.join(ROOT, 'metrics', 'episodes.csv'),
  descriptions: path.join(ROOT, 'metrics', 'descriptions.yaml'),
  settings: path.join(ROOT, 'settings.yaml'),
};
const METRIC_FILES = ['labs.csv', 'vitals.csv'].map((f) => path.join(ROOT, 'metrics', f));
const EPISODE_COLUMNS = ['date', 'case', 'duration', 'severity', 'before', 'helped', 'note'];
// Геном: знания о маркерах — общие, лежат в приложении; генотипы и оценки — в карте.
const GENOME = {
  panel: path.join(APP_ROOT, 'genome', 'panel.csv'),
  groups: path.join(APP_ROOT, 'genome', 'groups.yaml'),
  results: path.join(ROOT, 'genome', 'panel-results.csv'),
  notes: path.join(ROOT, 'genome', 'notes.yaml'),
  summary: path.join(ROOT, 'genome', 'summary.json'),
  findings: path.join(ROOT, 'genome', 'clinvar-findings.tsv'),
  coverage: path.join(ROOT, 'genome', 'clinvar-coverage.json'),
  origins: path.join(ROOT, 'genome', 'origins.json'),
  haplogroups: path.join(APP_ROOT, 'genome', 'haplogroups.yaml'),
};

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3737;
// Защита от DNS-rebinding и чужих сайтов: принимаем запросы только к своему адресу.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self'; object-src 'self'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

// ---------- утилиты ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': MIME['.json'] });
  res.end(JSON.stringify(body));
}

/** Путь внутри base или null, если пытаются выйти наружу. */
function inside(base, rel) {
  const p = path.resolve(base, rel);
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

const str = (v) => (v == null ? '' : String(v));
const dateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : str(v));
const list = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : v ? [str(v)] : []);
const oneLine = (v, max = 500) => str(v).replace(/\s+/g, ' ').trim().slice(0, max);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(str(v));
const toPosix = (p) => p.split(path.sep).join('/');
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

function localStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}`,
    iso: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** Запись через временный файл: при сбое исходный файл не портится. */
async function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, file);
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseFrontmatter(text) {
  text = text.replace(/^﻿/, '');
  const m = text.match(FRONTMATTER);
  if (!m) return { meta: {}, body: text };
  let meta = {};
  try {
    meta = YAML.parse(m[1]) ?? {};
  } catch {
    meta = { summary: '⚠️ Ошибка во frontmatter — проверь YAML' };
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Меняет поля frontmatter, сохраняя порядок, комментарии и тело файла. */
async function updateFrontmatter(file, mutate) {
  let text;
  try {
    text = (await fsp.readFile(file, 'utf8')).replace(/^﻿/, '');
  } catch {
    throw new HttpError(404, 'Не найдено');
  }
  const m = text.match(FRONTMATTER);
  if (!m) throw new HttpError(422, 'В файле нет frontmatter');
  const doc = YAML.parseDocument(m[1]);
  if (doc.errors.length) throw new HttpError(422, 'Ошибка во frontmatter — поправь YAML вручную');
  mutate(doc);
  await writeAtomic(file, `---\n${doc.toString({ lineWidth: 0, flowCollectionPadding: false }).trimEnd()}\n---\n${text.slice(m[0].length)}`);
}

/** Markdown → HTML. Относительные ссылки/картинки переписываются относительно baseUrl. */
function renderMarkdown(body, baseUrl) {
  const md = new Marked({
    gfm: true,
    walkTokens(token) {
      if (!baseUrl || (token.type !== 'link' && token.type !== 'image')) return;
      if (token.href && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(token.href)) {
        token.href = baseUrl + token.href.replace(/^\.\//, '');
      }
    },
  });
  return md.parse(body);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(field), (field = '');
    else if (c === '\n') row.push(field), rows.push(row), (row = []), (field = '');
    else if (c !== '\r') field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  const [header, ...data] = rows.filter((r) => r.some((f) => f.trim() !== ''));
  if (!header) return [];
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

async function readCsv(file) {
  try {
    return parseCsv(await fsp.readFile(file, 'utf8'));
  } catch {
    return []; // файла может ещё не быть
  }
}

// ---------- записи ----------

const STATUSES = new Set(['ok', 'watch', 'action']);

function normalizeSystems(systems) {
  if (!Array.isArray(systems)) return undefined;
  return systems
    .filter((s) => s && s.name)
    .map((s) => ({
      name: str(s.name),
      status: STATUSES.has(s.status) ? s.status : 'ok',
      note: str(s.note),
      case: str(s.case),
      record: str(s.record),
    }));
}

function normalizeMeta(meta, id) {
  const folder = id.split('/').pop();
  return {
    title: str(meta.title) || folder,
    date: dateStr(meta.date) || (folder.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? ''),
    type: str(meta.type) || 'note',
    status: str(meta.status),
    source: str(meta.source),
    summary: str(meta.summary),
    tags: list(meta.tags),
    systems: normalizeSystems(meta.systems),
  };
}

async function listRecords() {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Папка с report.md — это запись; глубже не идём (там могут быть тысячи DICOM).
    if (dir !== DIR.records && entries.some((e) => e.isFile() && e.name === 'report.md')) {
      const { meta } = parseFrontmatter(await fsp.readFile(path.join(dir, 'report.md'), 'utf8'));
      const id = toPosix(path.relative(DIR.records, dir));
      out.push({ id, ...normalizeMeta(meta, id) });
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) await walk(path.join(dir, e.name));
    }
  }
  await walk(DIR.records);
  out.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  return out;
}

async function listRecordFiles(dir) {
  const files = [];
  let dicom = false;
  async function walk(d) {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name.toLowerCase() === 'dicom') dicom = true;
        else await walk(p);
      } else {
        const rel = toPosix(path.relative(dir, p));
        if (rel !== 'report.md') files.push(rel);
      }
    }
  }
  await walk(dir);
  return { files: files.sort(), dicom };
}

async function getRecord(id) {
  const dir = inside(DIR.records, id);
  if (!dir || dir === DIR.records) return null;
  let text;
  try {
    text = await fsp.readFile(path.join(dir, 'report.md'), 'utf8');
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(text);
  const { files, dicom } = await listRecordFiles(dir);
  return {
    id,
    ...normalizeMeta(meta, id),
    html: renderMarkdown(body, `/records/${encPath(id)}/`),
    files,
    dicom,
  };
}

// ---------- кейсы ----------

const CASE_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
const PRIORITIES = new Set(['high', 'medium', 'low']);

function caseFile(id) {
  if (!CASE_ID.test(str(id))) throw new HttpError(400, 'Некорректный id кейса');
  return path.join(DIR.cases, `${id}.md`);
}

/** Цель кейса: к какому значению показателя идём и откуда считаем прогресс. */
function normalizeGoal(goal) {
  if (!goal || typeof goal !== 'object' || !goal.metric) return undefined;
  const target = Number(goal.target);
  if (goal.target == null || !Number.isFinite(target)) return undefined;
  const start = Number(goal.start);
  return {
    metric: str(goal.metric),
    target,
    start: goal.start != null && Number.isFinite(start) ? start : null,
    start_date: dateStr(goal.start_date),
  };
}

function normalizeCase(meta, id) {
  return {
    id,
    title: str(meta.title) || id,
    kind: str(meta.kind) || 'symptom',
    state: meta.state === 'closed' ? 'closed' : 'open',
    status: STATUSES.has(meta.status) ? meta.status : 'watch',
    priority: PRIORITIES.has(meta.priority) ? meta.priority : 'medium',
    opened: dateStr(meta.opened),
    closed: dateStr(meta.closed),
    resolution: str(meta.resolution),
    summary: str(meta.summary),
    next: str(meta.next),
    metrics: list(meta.metrics),
    records: list(meta.records),
    goal: normalizeGoal(meta.goal),
    updated: dateStr(meta.updated),
  };
}

async function listCases() {
  let names;
  try {
    names = await fsp.readdir(DIR.cases);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.md') || name.startsWith('.')) continue;
    const id = name.slice(0, -3);
    if (!CASE_ID.test(id)) continue;
    const { meta } = parseFrontmatter(await fsp.readFile(path.join(DIR.cases, name), 'utf8'));
    out.push(normalizeCase(meta, id));
  }
  return out;
}

async function getCase(id) {
  let text;
  try {
    text = await fsp.readFile(caseFile(id), 'utf8');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return null;
  }
  const { meta, body } = parseFrontmatter(text);
  return { ...normalizeCase(meta, id), html: renderMarkdown(body, '/cases/') };
}

/** Закрыть кейс или открыть снова — кнопки на сайте. */
async function setCaseState(body) {
  const file = caseFile(body.id);
  const today = localStamp().date;
  const closing = body.state === 'closed';
  const date = isDate(body.date) ? body.date : today;
  await updateFrontmatter(file, (doc) => {
    doc.set('state', closing ? 'closed' : 'open');
    if (closing) {
      doc.set('closed', date);
      doc.set('resolution', oneLine(body.note, 1000));
      doc.delete('reopened');
    } else {
      doc.delete('closed');
      doc.delete('resolution');
      doc.set('reopened', date);
    }
    doc.set('updated', today);
  });
  return getCase(body.id);
}

/** Приоритет кейса — переключатель на странице кейса. */
async function setCasePriority(body) {
  if (!PRIORITIES.has(body.priority)) throw new HttpError(400, 'Некорректный приоритет');
  await updateFrontmatter(caseFile(body.id), (doc) => {
    doc.set('priority', body.priority);
    doc.set('updated', localStamp().date);
  });
  return getCase(body.id);
}

async function addEpisode(body) {
  const file = caseFile(body.id);
  try {
    await fsp.access(file);
  } catch {
    throw new HttpError(404, 'Кейс не найден');
  }
  const severity = body.severity === '' || body.severity == null ? NaN : Number(body.severity);
  const row = {
    date: isDate(body.date) ? body.date : localStamp().date,
    case: body.id,
    duration: oneLine(body.duration, 80),
    severity: Number.isFinite(severity) ? String(Math.min(10, Math.max(0, Math.round(severity)))) : '',
    before: oneLine(body.before),
    helped: oneLine(body.helped),
    note: oneLine(body.note, 1000),
  };
  let text = '';
  try {
    text = await fsp.readFile(FILES.episodes, 'utf8');
  } catch {
    // первый эпизод — создаём файл
  }
  if (!text.trim()) text = `${EPISODE_COLUMNS.join(',')}\n`;
  if (!text.endsWith('\n')) text += '\n';
  text += `${EPISODE_COLUMNS.map((c) => csvCell(row[c])).join(',')}\n`;
  await writeAtomic(FILES.episodes, text);
  return row;
}

// ---------- план, закреплённые показатели ----------

async function getPlan() {
  let items;
  try {
    items = YAML.parse(await fsp.readFile(FILES.plan, 'utf8')) ?? [];
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  return items
    .filter((i) => i && i.id && i.title)
    .map((i) => ({
      id: str(i.id),
      date: dateStr(i.date),
      title: str(i.title),
      kind: str(i.kind) || 'task',
      note: str(i.note),
      record: str(i.record),
      case: str(i.case),
      done: i.done === true,
      done_date: dateStr(i.done_date),
    }));
}

async function setPlanDone(body) {
  let text;
  try {
    text = await fsp.readFile(FILES.plan, 'utf8');
  } catch {
    throw new HttpError(404, 'plan.yaml не найден');
  }
  const doc = YAML.parseDocument(text);
  if (doc.errors.length || !YAML.isSeq(doc.contents)) throw new HttpError(422, 'Ошибка в plan.yaml');
  const item = doc.contents.items.find((n) => YAML.isMap(n) && str(n.get('id')) === str(body.id));
  if (!item) throw new HttpError(404, 'Пункт плана не найден');
  item.set('done', body.done === true);
  if (body.done === true) item.set('done_date', localStamp().date);
  else item.delete('done_date');
  await writeAtomic(FILES.plan, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
  return { ok: true };
}

async function getPinned() {
  try {
    const value = JSON.parse(await fsp.readFile(FILES.pinned, 'utf8'));
    return Array.isArray(value) ? value.map(str) : [];
  } catch {
    return [];
  }
}

async function setPinned(body) {
  const test = oneLine(body.test, 200);
  if (!test) throw new HttpError(400, 'Не указан показатель');
  const pinned = (await getPinned()).filter((t) => t !== test);
  if (body.pinned === true) pinned.push(test);
  await writeAtomic(FILES.pinned, `${JSON.stringify(pinned, null, 2)}\n`);
  return pinned;
}

/** Описания показателей и оценка ассистента: название → { about, assessment, status, as_of }. */
async function getDescriptions() {
  let items;
  try {
    items = YAML.parse(await fsp.readFile(FILES.descriptions, 'utf8')) ?? [];
  } catch {
    return {};
  }
  const out = {};
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (!item?.test) continue;
    out[str(item.test)] = {
      about: str(item.about).trim(),
      assessment: str(item.assessment).trim(),
      status: STATUSES.has(item.status) ? item.status : '',
      as_of: dateStr(item.as_of),
    };
  }
  return out;
}

/** Настройки сайта из settings.yaml: имя ассистента в подписях и короткие названия лабораторий. */
async function getSettings() {
  let raw;
  try {
    raw = YAML.parse(await fsp.readFile(FILES.settings, 'utf8'));
  } catch {
    raw = null;
  }
  const labs = {};
  if (raw?.labs && typeof raw.labs === 'object' && !Array.isArray(raw.labs)) {
    for (const [name, short] of Object.entries(raw.labs)) if (str(short).trim()) labs[name] = str(short).trim().slice(0, 40);
  }
  return { assistant: str(raw?.assistant).trim().slice(0, 40), labs };
}

// ---------- геном ----------

async function readYamlFile(file, fallback) {
  try {
    return YAML.parse(await fsp.readFile(file, 'utf8')) ?? fallback;
  } catch {
    return fallback; // файла может не быть
  }
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const EVIDENCE_RANK = { высокая: 0, средняя: 1, низкая: 2 };

/** Патогенные совпадения с ClinVar и оценка их правдоподобия из notes.yaml. */
async function getGenomeFindings(notes) {
  let text;
  try {
    text = await fsp.readFile(GENOME.findings, 'utf8');
  } catch {
    return [];
  }
  const [head, ...lines] = text.split(/\r?\n/).filter(Boolean);
  const cols = head.split('\t');
  const verdicts = new Map((Array.isArray(notes.findings) ? notes.findings : []).filter((f) => f?.marker).map((f) => [str(f.marker), f]));
  return lines
    .map((line) => Object.fromEntries(line.split('\t').map((v, i) => [cols[i], v])))
    .filter((r) => /pathogenic/i.test(r.significance ?? '') && !/conflicting/i.test(r.significance))
    .map((r) => ({
      marker: str(r.marker),
      gene: str(r.gene),
      genotype: str(r.genotype),
      type: str(r.type),
      significance: str(r.significance),
      condition: str(r.condition),
      verdict: str(verdicts.get(r.marker)?.verdict).trim(),
      note: str(verdicts.get(r.marker)?.note).trim(),
    }));
}

/** Название гаплогруппы мтДНК начинается с этого префикса: «H» подходит к «H1a» и «H+195», но не к «HV» и не «H1» к «H10». */
function mtPrefixMatches(name, prefix) {
  if (!name.startsWith(prefix)) return false;
  const next = name[prefix.length];
  if (next === undefined) return true;
  const isDigit = (c) => /\d/.test(c);
  const isLetter = (c) => /[A-Za-z]/.test(c);
  const last = prefix.at(-1);
  return !((isDigit(last) && isDigit(next)) || (isLetter(last) && isLetter(next)));
}

/** Происхождение: результат расчёта из карты + общие рассказы о ветвях + оценка владельцу. */
async function getOrigins(notes) {
  const [data, stories] = await Promise.all([readJsonFile(GENOME.origins, null), readYamlFile(GENOME.haplogroups, {})]);
  if (!data) return null;
  const note = notes.origins && typeof notes.origins === 'object' ? notes.origins : {};
  const out = { generated: str(data.generated), y: null, mt: null, continents: null };
  if (data.y?.haplogroup) {
    const names = new Set(list(data.y.snps));
    out.y = {
      label: str(data.y.label),
      haplogroup: str(data.y.haplogroup),
      solid: data.y.solid ? { label: str(data.y.solid.label), haplogroup: str(data.y.solid.haplogroup) } : null,
      derived: Number(data.y.derived) || 0,
      conflicts: Number(data.y.conflicts) || 0,
      tested: Number(data.y.tested) || 0,
      tree: str(data.y.tree),
      stories: (Array.isArray(stories.y) ? stories.y : []).filter((s) => list(s.snps).some((x) => names.has(x))).map((s) => ({ name: str(s.name), story: str(s.story).trim() })),
      note: str(note.y).trim(),
    };
  }
  if (data.mt?.haplogroup) {
    const hg = str(data.mt.haplogroup);
    // Путь от корня дерева; узлы-развилки вида «U2'3'4» рассказов не получают.
    const trail = (list(data.mt.path).length ? list(data.mt.path) : [hg]).filter((n) => !n.includes("'"));
    const firstAt = (s) => trail.findIndex((n) => list(s.prefix).some((p) => mtPrefixMatches(n, p)));
    out.mt = {
      haplogroup: hg,
      score: Number(data.mt.score) || 0,
      found: Number(data.mt.found) || 0,
      expected: Number(data.mt.expected) || 0,
      tested: Number(data.mt.tested) || 0,
      tree: str(data.mt.tree),
      stories: (Array.isArray(stories.mt) ? stories.mt : [])
        .map((s) => ({ s, at: firstAt(s) }))
        .filter((x) => x.at >= 0)
        .sort((a, b) => a.at - b.at)
        .map(({ s }) => ({ name: str(s.name), story: str(s.story).trim() })),
      note: str(note.mt).trim(),
    };
  }
  if (data.continents?.shares) {
    out.continents = {
      shares: data.continents.shares,
      low: data.continents.low ?? {},
      high: data.continents.high ?? {},
      markers: Number(data.continents.markers) || 0,
      panel: str(data.continents.panel),
      reference: str(data.continents.reference),
      note: str(note.continents).trim(),
    };
  }
  return out.y || out.mt || out.continents ? out : null;
}

/** Геном: гены и темы из общих знаний + генотипы и оценки владельца. */
async function getGenome() {
  const [panel, results, groupList, notesRaw, summary, coverage] = await Promise.all([
    readCsv(GENOME.panel),
    readCsv(GENOME.results),
    readYamlFile(GENOME.groups, []),
    readYamlFile(GENOME.notes, {}),
    readJsonFile(GENOME.summary, null),
    readJsonFile(GENOME.coverage, null),
  ]);
  const notes = notesRaw && typeof notesRaw === 'object' && !Array.isArray(notesRaw) ? notesRaw : {};
  const got = new Map(results.map((r) => [r.rsid, r]));
  const noteOf = new Map((Array.isArray(notes.groups) ? notes.groups : []).filter((n) => n?.group).map((n) => [str(n.group), n]));
  const groups = [];
  for (const g of Array.isArray(groupList) ? groupList : []) {
    const key = str(g?.group);
    const markers = panel
      .filter((m) => key && m.group === key)
      .map((m) => ({
        gene: m.gene,
        rsid: m.rsid,
        variant: m.variant,
        effect_allele: m.effect_allele,
        effect: m.effect,
        evidence: m.evidence,
        source: m.source,
        updated: m.updated,
        genotype: got.get(m.rsid)?.genotype ?? '',
        copies: got.get(m.rsid)?.effect_copies ?? '',
        sources: got.get(m.rsid)?.sources ?? '', // какие тесты определили маркер
      }));
    if (!markers.length) continue;
    const n = noteOf.get(key);
    const genes = [...new Set(markers.map((m) => m.gene))];
    groups.push({
      group: key,
      section: str(g.section) || 'Прочее',
      title: str(g.title) || key,
      about: str(g.about).trim(),
      drugs: str(g.drugs).trim(),
      sensitive: g.sensitive === true,
      // Группа настолько надёжна, насколько надёжен её лучший маркер.
      evidence: markers.map((m) => m.evidence).sort((a, b) => (EVIDENCE_RANK[a] ?? 9) - (EVIDENCE_RANK[b] ?? 9))[0] ?? '',
      updated: markers.map((m) => m.updated).sort().at(-1) ?? '',
      markers,
      coverage: genes.filter((x) => coverage?.genes?.[x]).map((x) => ({ gene: x, known: coverage.genes[x].plp, onChip: coverage.genes[x].onChip })),
      note: n
        ? {
            result: str(n.result).trim(),
            status: STATUSES.has(n.status) ? n.status : '',
            assessment: str(n.assessment).trim(),
            advice: str(n.advice).trim(),
            metrics: list(n.metrics),
            cases: list(n.cases),
            as_of: dateStr(n.as_of),
          }
        : null,
    });
  }
  return {
    available: results.length > 0, // генотипы есть — значит, геном разобран
    summary: summary
      ? {
          exported: str(summary.exported),
          markers: Number(summary.markers) || 0,
          called: Number(summary.called) || 0,
          clinvar: summary.clinvar ?? null,
          tests: Array.isArray(summary.sources) ? summary.sources.map((x) => str(x.format)) : [],
          agreement: summary.agreement ?? null,
        }
      : null,
    text: str(notes.summary).trim(),
    record: str(notes.record),
    groups,
    findings: results.length ? await getGenomeFindings(notes) : [],
    origins: await getOrigins(notes),
  };
}

// ---------- профиль, показатели, входящие ----------

async function getProfile() {
  try {
    const { meta, body } = parseFrontmatter(await fsp.readFile(FILES.profile, 'utf8'));
    return { meta, html: renderMarkdown(body, null) };
  } catch {
    return { meta: {}, html: '' };
  }
}

async function getMetrics() {
  const all = [];
  for (const file of METRIC_FILES) all.push(...(await readCsv(file)));
  return all;
}

async function listInbox() {
  await fsp.mkdir(DIR.inbox, { recursive: true });
  const items = [];
  for (const e of await fsp.readdir(DIR.inbox, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const st = await fsp.stat(path.join(DIR.inbox, e.name));
    items.push({
      name: e.name,
      dir: e.isDirectory(),
      size: e.isDirectory() ? null : st.size,
      mtime: st.mtime.toISOString(),
    });
  }
  return items.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/** Всё, что нужно сайту для любой страницы, одним запросом. */
async function getState() {
  const [records, cases, plan, inbox, profile, metrics, episodes, pinned, descriptions, settings, genome] = await Promise.all([
    listRecords(),
    listCases(),
    getPlan(),
    listInbox(),
    getProfile(),
    getMetrics(),
    readCsv(FILES.episodes),
    getPinned(),
    getDescriptions(),
    getSettings(),
    getGenome(),
  ]);
  return {
    today: localStamp().date, records, cases, plan, inbox, profile: profile.meta, metrics, episodes, pinned, descriptions, settings, genome,
  };
}

// ---------- запись во входящие ----------

function cleanName(name) {
  const base = path
    .basename(str(name))
    .normalize('NFC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  return base || 'file';
}

/** Открывает новый файл, не перезаписывая существующие: name.pdf → name (2).pdf */
async function openUnique(dir, name) {
  await fsp.mkdir(dir, { recursive: true });
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${ext}`;
    const p = path.join(dir, candidate);
    try {
      return { fh: await fsp.open(p, 'wx'), name: candidate, path: p };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new HttpError(409, 'Слишком много файлов с таким именем');
}

async function saveUpload(req, rawName) {
  const { fh, name, path: p } = await openUnique(DIR.inbox, cleanName(rawName));
  try {
    await pipeline(req, fh.createWriteStream());
  } catch (err) {
    await fsp.rm(p, { force: true });
    throw err;
  }
  return { name };
}

async function readJson(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object') throw new Error('not an object');
    return value;
  } catch {
    throw new HttpError(400, 'Некорректный JSON');
  }
}

async function saveNote(body) {
  const kind = body.kind === 'symptom' ? 'symptom' : 'note';
  const text = str(body.text).trim();
  if (!text) throw new HttpError(400, 'Пустая заметка');
  const now = localStamp();
  const date = isDate(body.date) ? body.date : now.date;
  const meta = { type: kind, date, created: now.iso, source: 'быстрая заметка с сайта' };
  if (kind === 'symptom' && body.severity !== '' && Number.isFinite(Number(body.severity))) {
    meta.severity = Math.min(10, Math.max(0, Math.round(Number(body.severity))));
  }
  const { fh, name } = await openUnique(DIR.inbox, `${date}_${now.time}_${kind}.md`);
  try {
    await fh.writeFile(`---\n${YAML.stringify(meta)}---\n\n${text}\n`, 'utf8');
  } finally {
    await fh.close();
  }
  return { name };
}

// ---------- статика ----------

async function serveFile(res, file) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return json(res, 404, { error: 'Не найдено' });
  }
  if (!st.isFile()) return json(res, 404, { error: 'Не найдено' });
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': st.size,
  });
  await pipeline(fs.createReadStream(file), res);
}

// ---------- роутинг ----------

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return ALLOWED_HOSTS.has(new URL(origin).host);
  } catch {
    return false;
  }
}

const POST_ROUTES = {
  '/api/note': async (req) => [201, await saveNote(await readJson(req))],
  '/api/case/state': async (req) => [200, await setCaseState(await readJson(req))],
  '/api/case/priority': async (req) => [200, await setCasePriority(await readJson(req))],
  '/api/case/episode': async (req) => [201, await addEpisode(await readJson(req))],
  '/api/plan/done': async (req) => [200, await setPlanDone(await readJson(req))],
  '/api/pin': async (req) => [200, await setPinned(await readJson(req))],
};

async function handle(req, res) {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) throw new HttpError(421, 'Неизвестный хост');

  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'Некорректный URL');
  }

  if (req.method === 'POST') {
    // Кастомный заголовок + проверка Origin: чужая страница не сможет ничего записать.
    if (!originAllowed(req) || req.headers['x-medkarta'] !== '1') throw new HttpError(403, 'Запрещено');
    if (pathname === '/api/inbox') return json(res, 201, await saveUpload(req, url.searchParams.get('name')));
    const route = POST_ROUTES[pathname];
    if (!route) throw new HttpError(404, 'Не найдено');
    const [status, body] = await route(req);
    return json(res, status, body);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Метод не поддерживается');

  if (pathname === '/api/state') return json(res, 200, await getState());
  if (pathname === '/api/record') {
    const record = await getRecord(str(url.searchParams.get('id')));
    return record ? json(res, 200, record) : json(res, 404, { error: 'Запись не найдена' });
  }
  if (pathname === '/api/case') {
    const found = await getCase(str(url.searchParams.get('id')));
    return found ? json(res, 200, found) : json(res, 404, { error: 'Кейс не найден' });
  }
  if (pathname === '/api/profile') return json(res, 200, await getProfile());
  if (pathname === '/api/inbox') return json(res, 200, await listInbox());

  if (pathname.startsWith('/records/')) {
    const rel = pathname.slice('/records/'.length);
    const file = inside(DIR.records, rel);
    if (!file || rel.split('/').some((part) => part.startsWith('.'))) throw new HttpError(404, 'Не найдено');
    return serveFile(res, file);
  }

  const file = inside(DIR.public, pathname === '/' ? 'index.html' : pathname.slice(1));
  if (!file) throw new HttpError(404, 'Не найдено');
  return serveFile(res, file);
}

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Ошибка сервера' : err.message });
    else res.destroy();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} занят. Запусти с другим: PORT=3738 npm start`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`Медкарта: http://localhost:${PORT}`);
  if (ROOT !== APP_ROOT) console.log(`Данные: ${ROOT}`);
});
