#!/usr/bin/env node
/**
 * JaSH live playlist curator.
 *
 * Builds one combined playlist out of:
 *   - community source index  : https://playlists.dbprojects.workers.dev/api/sources
 *   - raw-github legacy feeds : maybetv/Jo, sportlive18/Sportlink-wtf
 *
 * Output catalogue:
 *   Tamil channels (all categories) + Tamil-language Bigg Boss 24/7
 *   + Tamil/English sports brands.
 * Sports rows without a Tamil/English label go to the review playlist and are
 * never relabelled by guesswork.
 *
 * Usage:
 *   node scripts/curate-live.mjs [--config <file>] [--out <dir>] [--snapshot <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSource } from './lib/parse.mjs';
import { buildClassifier, channelKey } from './lib/classify.mjs';
import { renderPlaylist } from './lib/render.mjs';
import { loadIndex, buildSourcePlan, readSource } from './lib/sources.mjs';
import { mapLimit } from './lib/net.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { config: path.join(here, 'curate-live.config.json'), out: process.env.OUTPUT_DIR || '.', snapshot: process.env.SOURCE_SNAPSHOT_DIR || '' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--config') args.config = argv[++i];
    else if (flag === '--out') args.out = argv[++i];
    else if (flag === '--snapshot') args.snapshot = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
const classifier = buildClassifier(config);
const now = Date.now();
const generatedAt = new Date(now).toISOString();
const safety = config.safety || {};
const concurrency = safety.concurrency || 6;
const timeoutMs = safety.timeoutMs || 20000;

const outputDir = path.resolve(args.out);
fs.mkdirSync(outputDir, { recursive: true });

/* ------------------------------------------------------------------ *
 * 1. Load upstreams
 * ------------------------------------------------------------------ */
const index = await loadIndex(config, { snapshotDir: args.snapshot, timeoutMs });
const plan = buildSourcePlan(config, index.rows);
const pinnedKeys = new Set((config.index?.pinned || []).map(String));

const loaded = await mapLimit([...plan.primary, ...plan.discovery], concurrency, async (source) => {
  if (source.skipped) return { source, skipped: true, entries: [], error: '' };
  const result = await readSource(source, { snapshotDir: args.snapshot, timeoutMs });
  if (!result.ok) return { source, entries: [], error: result.error };
  const entries = parseSource(result.text);
  return { source, entries, error: entries.length ? '' : 'no playlist entries' };
});

/* ------------------------------------------------------------------ *
 * 2. Classify, then decide which discovery sources earn a place
 * ------------------------------------------------------------------ */
const sourceReports = [];
const main = [];
const review = [];
const dropped = {};
const drop = (reason) => {
  dropped[reason] = (dropped[reason] || 0) + 1;
};

for (const item of loaded) {
  const { source } = item;
  const pinned = source.origin === 'index' && pinnedKeys.has(source.key);
  const report = {
    key: source.key,
    label: source.label,
    origin: source.origin,
    pinned,
    discovery: source.origin === 'index' && !pinned,
    skipped: Boolean(source.skipped),
    ok: !item.error && !source.skipped,
    parsed: item.entries.length,
    matched: 0,
    used: 0,
    error: item.error || (source.skipped ? `skipped: ${source.skipped}` : ''),
  };
  sourceReports.push(report);
  if (!item.entries.length) continue;

  const matched = [];
  for (const entry of item.entries) {
    const verdict = classifier.classify({ ...entry, source }, { now });
    if (verdict.kind === 'drop') {
      drop(verdict.reason);
      continue;
    }
    matched.push({ ...entry, ...verdict, source });
  }
  report.matched = matched.length;
  report.tamil = matched.filter((entry) => !entry.family).length;
  report.sports = matched.filter((entry) => entry.family).length;

  // Auto-discovery: an unpinned source only contributes if it actually carries
  // Tamil channels (or Tamil/English sports), so dead/hostile rows stay out.
  if (report.discovery && config.index?.autoDiscover !== false) {
    const enoughTamil = report.tamil >= (config.index?.autoDiscoverMinTamil ?? 3);
    const enoughSports = report.sports >= (config.index?.autoDiscoverMinSports ?? 1);
    if (!enoughTamil && !enoughSports) {
      report.error = 'discovered but no usable Tamil/sports rows';
      continue;
    }
    report.error = '';
    report.discovered = true;
  }

  for (const entry of matched) {
    (entry.kind === 'main' ? main : review).push(entry);
  }
}

/* ------------------------------------------------------------------ *
 * 3. Deduplicate: identical streams first, then alternate streams per brand
 * ------------------------------------------------------------------ */
const maxAlternates = Math.max(1, safety.maxAlternatesPerChannel || 3);

function collapse(entries) {
  // 1. One row per stream URL. When the same stream is published several times,
  //    keep the copy that carries the most playback metadata (clearkey, UA, cookie).
  const byStream = new Map();
  for (const entry of [...entries].sort((a, b) => a.source.priority - b.source.priority)) {
    const stream = entry.url.split('|')[0];
    const existing = byStream.get(stream);
    if (!existing) {
      byStream.set(stream, entry);
      continue;
    }
    drop('duplicate stream');
    if ((entry.props?.length || 0) > (existing.props?.length || 0)) byStream.set(stream, entry);
  }

  // 2. Cap alternate streams per brand so one channel cannot flood the feed.
  //    Rows with playback metadata are preferred when the cap is reached.
  const ordered = [...byStream.values()].sort(
    (a, b) => (a.props?.length ? 0 : 1) - (b.props?.length ? 0 : 1) || a.source.priority - b.source.priority,
  );
  const perBrand = new Map();
  const kept = [];
  for (const entry of ordered) {
    const key = channelKey(entry.name, entry.group, entry.language);
    const count = perBrand.get(key) || 0;
    if (count >= maxAlternates) {
      drop('alternate stream beyond cap');
      continue;
    }
    perBrand.set(key, count + 1);
    kept.push(entry);
  }
  return kept;
}

const mainEntries = collapse(main);
const reviewEntries = collapse(review);

/* ------------------------------------------------------------------ *
 * 4. Order: Bigg Boss, Tamil categories, sports brands, review
 * ------------------------------------------------------------------ */
const groupRank = new Map();
groupRank.set(config.groups.biggBoss, 0);
(config.tamil.categoryOrder || []).forEach((category, order) => {
  groupRank.set(`${config.groups.tamilPrefix}${category}`, order + 1);
});
Object.keys(config.sports.families || {})
  .filter((family) => family !== 'Bigg Boss')
  .forEach((family, order) => {
    groupRank.set(`${config.groups.sportsPrefix}${family} - Tamil`, 100 + order * 2);
    groupRank.set(`${config.groups.sportsPrefix}${family} - English`, 101 + order * 2);
    groupRank.set(`${config.groups.sportsPrefix}${family} - Language unknown`, 101 + order * 2);
  });
groupRank.set(config.groups.review, 9999);
const rankOf = (group) => groupRank.get(group) ?? 500;

const byGroupThenName = (a, b) =>
  rankOf(a.group) - rankOf(b.group) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name);
mainEntries.sort(byGroupThenName);
reviewEntries.sort(byGroupThenName);

/* ------------------------------------------------------------------ *
 * 5. Safety gate – never publish an empty or unrepresentative feed
 * ------------------------------------------------------------------ */
const okSources = sourceReports.filter((report) => report.ok && (report.matched > 0 || report.parsed > 0));
const tamilCount = mainEntries.filter((entry) => !entry.family).length;
const biggBossCount = mainEntries.filter((entry) => entry.family === 'Bigg Boss').length;

const failures = [];
if (mainEntries.length < (safety.minMainEntries ?? 20)) {
  failures.push(`only ${mainEntries.length} main entries (min ${safety.minMainEntries ?? 20})`);
}
if (okSources.length < (safety.minOkSources ?? 2)) {
  failures.push(`only ${okSources.length} usable sources (min ${safety.minOkSources ?? 2})`);
}
if (!tamilCount) failures.push('no Tamil channels matched');
if (failures.length) {
  throw new Error(`Insufficient source coverage (${failures.join('; ')}); existing output preserved.`);
}

/* ------------------------------------------------------------------ *
 * 6. Write outputs
 * ------------------------------------------------------------------ */
const tally = (entries) => {
  const counts = {};
  for (const entry of entries) counts[entry.group] = (counts[entry.group] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => rankOf(a[0]) - rankOf(b[0])));
};
const usedBySource = {};
for (const entry of [...mainEntries, ...reviewEntries]) {
  usedBySource[entry.source.key] = (usedBySource[entry.source.key] || 0) + 1;
}
for (const report of sourceReports) report.used = usedBySource[report.key] || 0;

const missingFamilies = Object.keys(config.sports.families || {})
  .filter((family) => family !== 'Bigg Boss')
  .filter((family) => !mainEntries.some((entry) => entry.family === family));

const stats = {
  generatedAt,
  configVersion: config.version || 2,
  playlistTitle: config.output.title,
  filters: {
    tamil: 'all Tamil-language channels (radio/audio excluded)',
    sports: `brands ${Object.keys(config.sports.families).join(', ')} in ${config.sports.languages.join('/')} only`,
    biggBoss: 'Tamil-labelled 24/7 feeds only',
    maxAlternatesPerChannel: maxAlternates,
  },
  staticSources: (config.staticSources || []).map((source) => ({
    id: source.id || source.url,
    url: source.url,
    used: usedBySource[source.id] || 0,
  })),
  index: {
    url: index.url,
    rows: index.rows.length,
    pinned: (config.index?.pinned || []).length,
    pinnedMissing: (config.index?.pinned || []).filter((id) => !index.rows.some((row) => row.id === id)),
    discovered: sourceReports.filter((report) => report.discovered).map((report) => report.key),
  },
  sources: sourceReports,
  main: {
    total: mainEntries.length,
    tamilChannels: tamilCount,
    biggBoss: biggBossCount,
    sports: mainEntries.filter((entry) => entry.family && entry.family !== 'Bigg Boss').length,
    // Rows accepted through the explicit sports.assertedEnglish list rather than
    // an upstream Tamil/English label.
    assertedLanguage: mainEntries.filter((entry) => entry.asserted).length,
    brands: new Set(mainEntries.map((entry) => channelKey(entry.name, entry.group, entry.language))).size,
    byGroup: tally(mainEntries),
  },
  review: { total: reviewEntries.length, byGroup: tally(reviewEntries) },
  dropped,
  missingSportsFamilies: missingFamilies,
  playbackVerified: false,
};

const files = config.output;
fs.writeFileSync(path.join(outputDir, files.main), renderPlaylist(mainEntries, {
  title: files.title,
  note: files.note,
  generatedAt,
  extraLines: [`#SUMMARY:${tamilCount} Tamil channels, ${biggBossCount} Bigg Boss Tamil, ${mainEntries.length - tamilCount - biggBossCount} sports feeds`],
}));
fs.writeFileSync(path.join(outputDir, files.review), renderPlaylist(reviewEntries, {
  title: `${files.title} - review queue`,
  note: 'Not part of the main feed: sports rows without a verifiable Tamil/English label.',
  generatedAt,
}));
fs.writeFileSync(path.join(outputDir, files.stats), `${JSON.stringify(stats, null, 2)}\n`);
fs.writeFileSync(path.join(outputDir, files.reviewJson), `${JSON.stringify(
  reviewEntries.map((entry) => ({
    name: entry.name,
    family: entry.family,
    reason: entry.reason || 'language not stated upstream',
    source: { key: entry.source.key, label: entry.source.label, origin: entry.source.origin },
  })),
  null,
  2,
)}\n`);

/* ------------------------------------------------------------------ *
 * 7. Human-readable summary (replaces the hand-maintained markdown)
 * ------------------------------------------------------------------ */
function renderSummary() {
  const lines = [
    '# Current curated feed',
    '',
    `Generated ${generatedAt} by \`scripts/curate-live.mjs\` — do not edit by hand.`,
    '',
    `${mainEntries.length} stream options in \`${files.main}\`: ${tamilCount} Tamil channels, ${biggBossCount} Bigg Boss Tamil, ${stats.main.sports} sports feeds.`,
    `${reviewEntries.length} further stream options are parked in \`${files.review}\` because upstream states no Tamil/English language.`,
    '',
    '| Group | Streams |',
    '|---|---:|',
    ...Object.entries(stats.main.byGroup).map(([group, count]) => `| ${group} | ${count} |`),
    '',
    '## Channels (alternate streams of the same brand may repeat)',
    '',
  ];
  const seen = new Set();
  for (const [group, count] of Object.entries(stats.main.byGroup)) {
    lines.push(`### ${group} (${count})`, '');
    const names = [...new Set(mainEntries.filter((entry) => entry.group === group).map((entry) => entry.name))];
    for (const name of names) {
      const key = `${group}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${name}`);
    }
    lines.push('');
  }
  lines.push(
    '## Upstream sources used',
    '',
    '| Source | Kind | Entries used |',
    '|---|---|---:|',
    ...sourceReports
      .filter((report) => report.used > 0 || report.discovered)
      .map((report) => `| ${report.label} | ${report.discovered ? 'discovered' : report.pinned ? 'pinned' : report.origin} | ${report.used} |`),
    '',
    `Sources that returned nothing this run: ${sourceReports.filter((report) => !report.ok).length} of ${sourceReports.length}. See \`${files.stats}\`.`,
    '',
    'Playback was **not** verified: entries carry upstream playback properties unchanged, and a stream may still need a compatible player, legitimate access or region availability.',
    '',
  );
  return `${lines.join('\n').trimEnd()}\n`;
}
fs.writeFileSync(path.join(outputDir, 'CHANNEL-SUMMARY.md'), renderSummary());

console.log(JSON.stringify({
  mainEntries: mainEntries.length,
  tamilChannels: tamilCount,
  biggBoss: biggBossCount,
  sports: stats.main.sports,
  reviewEntries: reviewEntries.length,
  okSources: okSources.length,
  discovered: stats.index.discovered,
  missingSportsFamilies: missingFamilies,
}));
