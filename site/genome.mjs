#!/usr/bin/env node
// Геном: поиск маркеров в сыром файле 23andMe и сверка с открытой базой ClinVar.
// Всё считается на этом компьютере — ни генотипы, ни список проверяемых маркеров никуда не отправляются.
//
//   npm run genome -- stats                        сводка по файлу генома
//   npm run genome -- lookup rs1800562 6:26091179  генотип по rsid или «хромосома:позиция»
//   npm run genome -- panel                        генотипы по списку маркеров → genome/panel-results.csv
//   npm run genome -- clinvar                      сверка со всем ClinVar → genome/clinvar-findings.tsv
//   npm run genome -- tables [раздел…]             таблицы для отчёта (markdown)
//
// Общие знания (в папке приложения):   genome/panel.csv — маркеры, genome/groups.yaml — гены и темы.
// Данные человека (в папке карты):     genome/raw/*.txt — сырой файл 23andMe (сборка 37, «плюс»-цепь),
//                                      genome/ref/clinvar/clinvar.vcf.gz — ClinVar, сборка 37 (скачивается отдельно),
//                                      genome/panel-results.csv, clinvar-findings.tsv, clinvar-coverage.json,
//                                      summary.json — результаты, их читает сайт.
// Правила — docs/GENOME.md.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import YAML from 'yaml';
import { APP_ROOT, resolveDataRoot } from './root.mjs';

const ROOT = resolveDataRoot();
const KNOW = path.join(APP_ROOT, 'genome');
const DATA = path.join(ROOT, 'genome');
const RAW_DIR = path.join(DATA, 'raw');
const CLINVAR = path.join(DATA, 'ref', 'clinvar', 'clinvar.vcf.gz');
const PANEL = path.join(KNOW, 'panel.csv');
const GROUPS = path.join(KNOW, 'groups.yaml');
const RESULTS = path.join(DATA, 'panel-results.csv');
const FINDINGS = path.join(DATA, 'clinvar-findings.tsv');
const COVERAGE = path.join(DATA, 'clinvar-coverage.json');
const SUMMARY = path.join(DATA, 'summary.json');
const PANEL_REF = path.join(DATA, 'ref', 'panel-clinvar.json');

const today = () => new Date().toISOString().slice(0, 10);
const relData = (file) => path.relative(ROOT, file);

function fail(text) {
  console.error(text);
  process.exit(1);
}

// ---------- геном ----------

function rawFile() {
  const files = fs.existsSync(RAW_DIR) ? fs.readdirSync(RAW_DIR).filter((f) => f.endsWith('.txt')).sort() : [];
  if (!files.length) fail(`В ${relData(RAW_DIR) || RAW_DIR} нет файла генома. Положите туда сырой файл 23andMe (.txt) — см. docs/GENOME.md.`);
  return path.join(RAW_DIR, files[files.length - 1]);
}

/** byId: rsid → {id, chr, pos, gt}; byPos: «chr:pos» → [маркеры]. Генотип «--» — маркер не определён. */
function loadGenome() {
  const byId = new Map();
  const byPos = new Map();
  const header = [];
  for (const raw of fs.readFileSync(rawFile(), 'utf8').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    if (line.startsWith('#')) {
      header.push(line);
      continue;
    }
    const [id, chr, pos, gt] = line.split('\t');
    if (!gt) continue;
    const m = { id, chr, pos: Number(pos), gt };
    byId.set(id, m);
    const key = `${chr}:${pos}`;
    if (byPos.has(key)) byPos.get(key).push(m);
    else byPos.set(key, [m]);
  }
  if (!byId.size) fail('Файл генома не похож на сырые данные 23andMe: нужны строки «rsid, хромосома, позиция, генотип» через табуляцию.');
  return { byId, byPos, header };
}

const called = (m) => Boolean(m && m.gt && !m.gt.includes('-'));

// ---------- CSV и сводка ----------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), (i += 1);
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') (row.push(cell), (cell = ''));
    else if (ch === '\n') (row.push(cell), rows.push(row), (row = []), (cell = ''));
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) (row.push(cell), rows.push(row));
  const [head, ...body] = rows.filter((r) => r.some((c) => c !== ''));
  return head ? body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']))) : [];
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

const readPanel = () => (fs.existsSync(PANEL) ? parseCsv(fs.readFileSync(PANEL, 'utf8')) : fail(`Нет списка маркеров: ${PANEL}`));

/** Сводка для сайта: каждая команда дописывает свою часть. */
function saveSummary(patch) {
  let summary = {};
  try {
    summary = JSON.parse(fs.readFileSync(SUMMARY, 'utf8'));
  } catch {
    // сводки ещё нет
  }
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(SUMMARY, `${JSON.stringify({ ...summary, ...patch }, null, 1)}\n`);
}

function fileSummary(genome) {
  let nocall = 0;
  let xHaploid = 0;
  let xDiploid = 0;
  let yCalled = 0;
  for (const m of genome.byId.values()) {
    if (!called(m)) {
      nocall += 1;
      continue;
    }
    if (m.chr === 'X') m.gt.length === 1 ? (xHaploid += 1) : (xDiploid += 1);
    if (m.chr === 'Y') yCalled += 1;
  }
  const stamp = genome.header.find((l) => l.includes('timestamp'))?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
  return {
    file: path.basename(rawFile()),
    exported: stamp,
    markers: genome.byId.size,
    called: genome.byId.size - nocall,
    // Одна X-хромосома читается одной буквой; у женщин на X — пары букв, а Y не определяется.
    sex: xHaploid > xDiploid && yCalled > 100 ? 'мужской' : xDiploid > xHaploid ? 'женский' : '',
  };
}

// ---------- ClinVar ----------

function infoOf(field) {
  const info = {};
  for (const part of field.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) info[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return info;
}

/** Сколько копий варианта ClinVar у человека: 1 или 2; null — нет или сравнить нельзя. */
function copies(marker, ref, alt) {
  const gt = marker.gt;
  if (ref.length !== alt.length) {
    // Вставки и делеции 23andMe кодирует буквами I и D, и по файлу нельзя узнать, какая из них — обычный вариант:
    // «II» и «DD» у здорового человека встречаются у сотен «патогенных» записей, то есть означают норму.
    // Надёжно читается только гетерозигота (DI): два разных аллеля — значит, один из них вариант.
    return gt === 'DI' || gt === 'ID' ? 1 : null;
  }
  if (ref.length !== 1 || !/^[ACGT]{1,2}$/.test(gt)) return null;
  return [...gt].filter((a) => a === alt).length || null;
}

const SIG_KEEP = /pathogenic|risk_factor|drug_response|association|protective|affects|confers_sensitivity/i;
const isPathogenic = (sig) => /pathogenic/i.test(sig) && !/conflicting/i.test(sig);

async function clinvar() {
  if (!fs.existsSync(CLINVAR)) {
    fail(`Нет файла ${relData(CLINVAR)}.\nСкачайте ClinVar (сборка 37): https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh37/clinvar.vcf.gz — около 200 МБ.`);
  }
  const genome = loadGenome();
  const panelIds = new Set(readPanel().map((r) => r.rsid));
  const panelRef = new Map();
  const cov = { fileDate: '', records: 0, plp: 0, plpOnChip: 0, plpOnChipCalled: 0, plpSnvCalled: 0, plpIndelCalled: 0, genes: {} };
  const out = [];
  const rl = readline.createInterface({ input: fs.createReadStream(CLINVAR).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.startsWith('#')) {
      if (line.startsWith('##fileDate=')) cov.fileDate = line.slice(11);
      continue;
    }
    const [chr, pos, cvId, ref, alt, , , infoField] = line.split('\t');
    if (!alt || alt === '.') continue;
    cov.records += 1;
    const info = infoOf(infoField);
    const sig = info.CLNSIG ?? '';
    const gene = (info.GENEINFO ?? '').split(':')[0];
    const rs = info.RS ? info.RS.split('|').map((r) => `rs${r}`) : [];
    const isIndel = ref.length !== alt.length;

    // Маркеры чипа, которые соответствуют этой записи: по позиции (точечные замены) и по rsid (любые).
    const found = new Map();
    if (!isIndel) for (const m of genome.byPos.get(`${chr}:${pos}`) ?? []) found.set(m.id, m);
    for (const id of rs) {
      const m = genome.byId.get(id);
      if (m && m.chr === chr) found.set(m.id, m);
    }
    // Для маркеров из нашего списка запоминаем аллели ClinVar — по ним сверяется направление эффекта.
    for (const id of rs) {
      if (!panelIds.has(id)) continue;
      const known = panelRef.get(id);
      if (!known) panelRef.set(id, { ref, alt: [alt], gene });
      else if (known.ref === ref && !known.alt.includes(alt)) known.alt.push(alt);
    }

    if (isPathogenic(sig)) {
      cov.plp += 1;
      const g = (cov.genes[gene] ??= { plp: 0, onChip: 0 });
      g.plp += 1;
      if (found.size) (cov.plpOnChip += 1), (g.onChip += 1);
      if ([...found.values()].some(called)) {
        cov.plpOnChipCalled += 1;
        if (isIndel) cov.plpIndelCalled += 1;
        else cov.plpSnvCalled += 1;
      }
    }
    if (!found.size || !SIG_KEEP.test(sig)) continue;
    for (const m of found.values()) {
      if (!called(m)) continue;
      const n = copies(m, ref, alt);
      if (!n) continue;
      out.push({
        chr,
        pos,
        marker: m.id,
        genotype: m.gt,
        copies: m.gt.length === 1 ? '1 (одна хромосома)' : n,
        ref,
        alt,
        gene,
        significance: sig,
        review: info.CLNREVSTAT ?? '',
        condition: (info.CLNDN ?? '').replace(/_/g, ' '),
        type: info.CLNVC ?? '',
        consequence: (info.MC ?? '').split(',').map((c) => c.split('|')[1]).filter(Boolean).join('/'),
        af_exac: info.AF_EXAC ?? '',
        af_tgp: info.AF_TGP ?? '',
        clinvar_id: cvId,
      });
    }
  }
  const cols = ['chr', 'pos', 'marker', 'genotype', 'copies', 'ref', 'alt', 'gene', 'significance', 'review', 'condition', 'type', 'consequence', 'af_exac', 'af_tgp', 'clinvar_id'];
  const chrOrder = (c) => (/^\d+$/.test(c) ? Number(c) : c === 'X' ? 23 : c === 'Y' ? 24 : 25);
  out.sort((a, b) => chrOrder(a.chr) - chrOrder(b.chr) || a.pos - b.pos);
  fs.writeFileSync(FINDINGS, `${cols.join('\t')}\n${out.map((r) => cols.map((c) => r[c]).join('\t')).join('\n')}\n`);
  const genes = Object.fromEntries(Object.entries(cov.genes).sort((a, b) => b[1].plp - a[1].plp));
  fs.writeFileSync(COVERAGE, `${JSON.stringify({ ...cov, genes }, null, 1)}\n`);
  fs.writeFileSync(PANEL_REF, `${JSON.stringify(Object.fromEntries(panelRef), null, 1)}\n`);
  const pathogenic = out.filter((r) => isPathogenic(r.significance)).length;
  saveSummary({
    ...fileSummary(genome),
    clinvar: {
      date: cov.fileDate,
      plp: cov.plp,
      onChip: cov.plpOnChip,
      called: cov.plpOnChipCalled,
      snv: cov.plpSnvCalled,
      indel: cov.plpIndelCalled,
      matches: out.length,
      pathogenic,
      generated: today(),
    },
  });
  console.log(`ClinVar от ${cov.fileDate}: записей ${cov.records}, патогенных и вероятно патогенных ${cov.plp}`);
  console.log(`  из них на чипе есть ${cov.plpOnChip} (${((100 * cov.plpOnChip) / cov.plp).toFixed(1)} %), определены ${cov.plpOnChipCalled}`);
  console.log(`  совпадений с геномом: ${out.length}, из них патогенных — ${pathogenic} → ${relData(FINDINGS)}`);
  console.log('  Редкие «патогенные» совпадения в сырых данных часто ложные — каждое нужно проверить на правдоподобие (docs/GENOME.md).');
}

// ---------- команды ----------

function stats() {
  const genome = loadGenome();
  const s = fileSummary(genome);
  saveSummary(s);
  console.log(s.file);
  console.log(`  выгружен ${s.exported || '—'} · маркеров ${s.markers}, определено ${s.called} (${((100 * s.called) / s.markers).toFixed(2)} %) · пол по данным: ${s.sex || 'не определён'}`);
}

function lookup(args) {
  if (!args.length) fail('Укажите rsid или «хромосома:позиция».');
  const { byId, byPos } = loadGenome();
  for (const a of args) {
    const hits = a.includes(':') ? (byPos.get(a) ?? []) : byId.has(a) ? [byId.get(a)] : [];
    if (!hits.length) console.log(`${a}\tнет на чипе`);
    for (const m of hits) console.log(`${m.id}\t${m.chr}\t${m.pos}\t${m.gt}`);
  }
}

function panel() {
  const genome = loadGenome();
  const rows = readPanel();
  const clin = fs.existsSync(PANEL_REF) ? JSON.parse(fs.readFileSync(PANEL_REF, 'utf8')) : {};
  const cols = ['rsid', 'chr', 'pos', 'genotype', 'effect_copies', 'clinvar_ref_alt'];
  const lines = [cols.join(',')];
  let onChip = 0;
  let isCalled = 0;
  const mismatch = [];
  for (const r of rows) {
    const m = genome.byId.get(r.rsid);
    if (m) onChip += 1;
    if (called(m)) isCalled += 1;
    const n = called(m) && r.effect_allele ? [...m.gt].filter((a) => a === r.effect_allele).length : '';
    const cv = clin[r.rsid];
    // Аллель с эффектом должен быть одним из аллелей ClinVar — иначе в списке перепутана цепь или буква.
    if (cv && r.effect_allele && /^[ACGT]$/.test(r.effect_allele) && cv.ref.length === 1 && ![cv.ref, ...cv.alt].includes(r.effect_allele)) {
      mismatch.push(`${r.rsid} (${r.gene}): в списке «${r.effect_allele}», в ClinVar ${cv.ref}>${cv.alt.join('/')}`);
    }
    lines.push([r.rsid, m?.chr ?? '', m?.pos ?? '', m ? m.gt : '', n, cv ? `${cv.ref}>${cv.alt.join('/')}` : ''].map(csvCell).join(','));
  }
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(RESULTS, `${lines.join('\n')}\n`);
  saveSummary({ ...fileSummary(genome), panel: { markers: rows.length, onChip, called: isCalled, generated: today() } });
  console.log(`Маркеров в списке ${rows.length}: на чипе ${onChip}, определено ${isCalled} → ${relData(RESULTS)}`);
  if (!Object.keys(clin).length) console.log('  Направление аллелей не сверено: сначала запустите «clinvar».');
  for (const text of mismatch) console.log(`  ! аллель не сходится с ClinVar — ${text}`);
}

/** Генотип для чтения: «A/G»; одна буква — у маркеров на X, Y и митохондриальной ДНК. */
const showGt = (gt) => (!gt ? 'нет на чипе' : gt.includes('-') ? 'не определён' : gt.length === 2 ? `${gt[0]}/${gt[1]}` : gt);

function copiesText(r) {
  const gt = r.genotype;
  if (!gt || gt.includes('-')) return '—';
  if (!r.effect_allele) {
    if (/^[DI]{2}$/.test(gt)) return gt[0] === gt[1] ? 'вариант не найден' : 'одна копия';
    return gt.length === 2 && gt[0] !== gt[1] ? 'одна копия' : '—';
  }
  const n = Number(r.effect_copies);
  if (gt.length === 1) return n ? 'есть' : 'нет';
  return ['нет', 'одна', 'две'][n] ?? '—';
}

function tables(args) {
  if (!fs.existsSync(RESULTS)) fail('Нет результатов — сначала запустите «panel».');
  const results = new Map(parseCsv(fs.readFileSync(RESULTS, 'utf8')).map((r) => [r.rsid, r]));
  const rows = readPanel().map((r) => ({ ...r, genotype: results.get(r.rsid)?.genotype ?? '', effect_copies: results.get(r.rsid)?.effect_copies ?? '' }));
  const order = fs.existsSync(GROUPS) ? (YAML.parse(fs.readFileSync(GROUPS, 'utf8')) ?? []).map((g) => String(g.group)) : [];
  const rank = (g) => (order.indexOf(g) + 1 || 999);
  rows.sort((a, b) => rank(a.group) - rank(b.group));
  const sections = [...new Set(rows.map((r) => r.section))].filter((sec) => !args.length || args.includes(sec));
  for (const sec of sections) {
    console.log(`<!-- ${sec} -->`);
    console.log('| Ген | Вариант | Маркер | Генотип | Копий варианта | Что делает вариант |');
    console.log('|---|---|---|---|---|---|');
    for (const r of rows.filter((x) => x.section === sec)) {
      const allele = r.effect_allele ? ` (${r.effect_allele})` : '';
      console.log(`| ${r.gene} | ${r.variant}${allele} | ${r.rsid} | ${showGt(r.genotype)} | ${copiesText(r)} | ${r.effect} |`);
    }
    console.log('');
  }
}

// ---------- запуск ----------

const argv = process.argv.slice(2).filter((a, i, all) => a !== '--root' && all[i - 1] !== '--root' && !a.startsWith('--root='));
const [cmd, ...args] = argv;
if (cmd === 'stats') stats();
else if (cmd === 'lookup') lookup(args);
else if (cmd === 'panel') panel();
else if (cmd === 'clinvar') await clinvar();
else if (cmd === 'tables') tables(args);
else console.log('Команды: stats | lookup <rsid|хромосома:позиция>… | panel | clinvar | tables [раздел…]\nПодробно — docs/GENOME.md.');
