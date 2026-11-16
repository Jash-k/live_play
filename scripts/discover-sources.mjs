#!/usr/bin/env node
/**
 * GitHub source hunter.
 *
 * Finds IPTV playlist repositories on GitHub, lists their playlist files, and
 * verifies each one with *this project's own* parser and classifier — so a
 * "working" source means "returns a playlist that actually yields Tamil or
 * Tamil/English sports rows", not merely "HTTP 200".
 *
 * Usage:
 *   node scripts/discover-sources.mjs                     # default queries + known repos
 *   node scripts/discover-sources.mjs --repo owner/name   # add explicit repos
 *   node scripts/discover-sources.mjs --search "tamil iptv,jiotv m3u"
 *   node scripts/discover-sources.mjs --json report.json  # machine-readable output
 *   node scripts/discover-sources.mjs --audit             # also health-check config sources
 *
 * Unauthenticated GitHub allows ~60 API calls/hour, so file listings are cached
 * in a temp dir (--cache-dir) and reused between runs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSource } from './lib/parse.mjs';
import { buildClassifier } from './lib/classify.mjs';
import { mapLimit, fetchText } from './lib/net.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_QUERIES = [
  'tamil iptv',
  'tamil m3u',
  'jiotv m3u',
  'iptv playlist india',
  'sonyliv m3u',
  'cricket iptv m3u',
  'sports iptv m3u',
  'bigg boss tamil',
];

/** Repos worth re-checking even when search does not surface them. */
const KNOWN_REPOS = [
  'amazeyourself/tamil-local-iptv',
  'amazeyourself/m3u',
  'snwebdev211-jpg/Tamil-World-IPTV',
  'kirubanandem/iptv_playlist',
  'iqbal8846/sports-iptv',
  'DebugDyno/yo_events',
  'merrychristmasdec/Lotuz-TV',
  'Jitendraunatti/JioTv',
  'lazyop/JioTV-Localhost',
  'senpaiorbit/TS-JioTV',
  'mirza-shafi/StreamFy',
  'LS-Station/IPTVPulse-Daily-Updates',
  'shivaprakashr16dev/TAMIL-IPTV-org-working-only',
  'tamil-in-iptv/tamil-in-iptv.github.io',
  'Tamilwebcast/Tamilwebcast.github.io',
  'prabhacap/IPTV',
  'AsianPingu/Tamil-IPTV',
];

function parseArgs(argv) {
  const args = {
    queries: DEFAULT_QUERIES,
    repos: [...KNOWN_REPOS],
    maxBytes: 8 * 1024 * 1024,
    concurrency: 4,
    timeoutMs: 25000,
    perRepoFiles: 6,
    json: '',
    cacheDir: path.join(os.tmpdir(), 'jash-discover-cache'),
    audit: false,
    minTamil: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--search') args.queries = argv[++i].split(',').map((value) => value.trim()).filter(Boolean);
    else if (flag === '--repo') args.repos.push(argv[++i]);
    else if (flag === '--max-bytes') args.maxBytes = Number(argv[++i]);
    else if (flag === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (flag === '--per-repo-files') args.perRepoFiles = Number(argv[++i]);
    else if (flag === '--min-tamil') args.minTamil = Number(argv[++i]);
    else if (flag === '--json') args.json = argv[++i];
    else if (flag === '--cache-dir') args.cacheDir = argv[++i];
    else if (flag === '--audit') args.audit = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const config = JSON.parse(fs.readFileSync(path.join(here, 'curate-live.config.json'), 'utf8'));
const { classify } = buildClassifier(config);
fs.mkdirSync(args.cacheDir, { recursive: true });

const gh = async (url) => JSON.parse(await fetchText(url, { timeoutMs: args.timeoutMs, retries: 1 }));
const rawUrl = (repo, branch, file) =>
  `https://raw.githubusercontent.com/${repo}/${branch || 'HEAD'}/${file.split('/').map(encodeURIComponent).join('/')}`;

/* ------------------------------------------------------------------ *
 * 1. Candidate repositories
 * ------------------------------------------------------------------ */
const candidates = new Map();
for (const repo of args.repos) candidates.set(repo, { repo, stars: 0, pushed: '', via: 'known' });
for (const query of args.queries) {
  try {
    const result = await gh(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&per_page=15`,
    );
    for (const item of result.items || []) {
      const existing = candidates.get(item.full_name);
      const record = {
        repo: item.full_name,
        stars: item.stargazers_count,
        pushed: item.pushed_at,
        branch: item.default_branch,
        via: existing ? `${existing.via}+search` : `search:${query}`,
      };
      candidates.set(item.full_name, { ...(existing || {}), ...record });
    }
    console.error(`search "${query}": ${result.total_count} repos, ${(result.items || []).length} inspected`);
  } catch (error) {
    console.error(`search "${query}" failed: ${String(error.message).slice(0, 80)}`);
  }
}

/* ------------------------------------------------------------------ *
 * 2. List playlist files per repository (cached)
 * ------------------------------------------------------------------ */
const PLAYLIST_FILE = /\.(?:m3u8?|json)$/i;

async function listFiles(repo, branch) {
  const cacheFile = path.join(args.cacheDir, `${repo.replace(/[^\w.-]+/g, '_')}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  let tree;
  try {
    tree = await gh(`https://api.github.com/repos/${repo}/git/trees/${branch || 'HEAD'}?recursive=1`);
  } catch (error) {
    return { error: String(error.message).slice(0, 80), files: [] };
  }
  const files = (tree.tree || [])
    .filter((node) => node.type === 'blob' && PLAYLIST_FILE.test(node.path) && node.size > 200 && node.size <= args.maxBytes)
    .map((node) => ({ path: node.path, size: node.size }))
    .sort((a, b) => b.size - a.size);
  const out = { error: tree.truncated ? 'tree truncated' : '', files };
  fs.writeFileSync(cacheFile, JSON.stringify(out));
  return out;
}

/* ------------------------------------------------------------------ *
 * 3. Verify each playlist with the project's own parser + classifier
 * ------------------------------------------------------------------ */
function tally(text, repo, file) {
  let entries;
  try {
    entries = parseSource(text);
  } catch {
    return null;
  }
  const result = {
    repo,
    file,
    bytes: text.length,
    parsed: entries.length,
    tamil: 0,
    sports: 0,
    biggBoss: 0,
    review: 0,
    groups: new Set(),
    sample: [],
  };
  for (const entry of entries) {
    const verdict = classify({ ...entry, source: { key: repo, label: repo, short: repo, origin: 'github', priority: 999, familyHint: '' } }, { now: Date.now() });
    if (verdict.kind === 'main' && verdict.family === 'Bigg Boss') result.biggBoss++;
    else if (verdict.kind === 'main' && verdict.family) result.sports++;
    else if (verdict.kind === 'main') result.tamil++;
    else if (verdict.kind === 'review') result.review++;
    if (verdict.kind === 'main') {
      result.groups.add(verdict.group);
      if (result.sample.length < 6) result.sample.push(entry.name);
    }
  }
  result.groups = [...result.groups];
  return result;
}

const reports = [];
const repos = [...candidates.values()];
await mapLimit(repos, args.concurrency, async (candidate) => {
  const listing = await listFiles(candidate.repo, candidate.branch);
  if (listing.error && !listing.files.length) {
    reports.push({ ...candidate, files: 0, error: listing.error });
    return;
  }
  const picked = listing.files.slice(0, args.perRepoFiles);
  const results = [];
  for (const file of picked) {
    try {
      const text = await fetchText(rawUrl(candidate.repo, candidate.branch, file.path), { timeoutMs: args.timeoutMs, retries: 0 });
      const result = tally(text, candidate.repo, file.path);
      if (result && (result.tamil + result.sports + result.biggBoss + result.review) > 0) results.push(result);
    } catch {
      /* a dead file in an otherwise live repo is not interesting */
    }
  }
  const best = results.sort((a, b) => (b.tamil + b.sports + b.biggBoss) - (a.tamil + a.sports + a.biggBoss))[0] || null;
  reports.push({
    ...candidate,
    files: listing.files.length,
    error: results.length ? '' : listing.error || 'no usable playlist rows',
    best,
    alternatives: results.slice(1, 4).map((result) => ({ file: result.file, tamil: result.tamil, sports: result.sports })),
  });
});

/* ------------------------------------------------------------------ *
 * 4. Report
 * ------------------------------------------------------------------ */
const score = (report) => (report.best ? report.best.tamil + report.best.sports + report.best.biggBoss * 3 : 0);
reports.sort((a, b) => score(b) - score(a) || (b.stars || 0) - (a.stars || 0));

console.log('\nWORKING SOURCES (verified with this project\'s classifier)\n');
console.log('TAMIL SPORTS  BB  REVIEW  STARS  PUSHED      REPO  ::  BEST FILE');
for (const report of reports) {
  if (!report.best) continue;
  const b = report.best;
  console.log(
    `${String(b.tamil).padStart(5)} ${String(b.sports).padStart(5)} ${String(b.biggBoss).padStart(3)} ` +
      `${String(b.review).padStart(6)}  ${String(report.stars).padStart(5)}  ${(report.pushed || '').slice(0, 10).padEnd(11)} ` +
      `${report.repo}  ::  ${b.file} (${Math.round(b.bytes / 1024)} KB)`,
  );
}
const dead = reports.filter((report) => !report.best);
console.log(`\nREJECTED: ${dead.length} repos`);
for (const report of dead.slice(0, 25)) console.log(`  ${report.repo.padEnd(45)} ${report.error}`);

/* ------------------------------------------------------------------ *
 * 5. Config snippet for the winners
 * ------------------------------------------------------------------ */
const winners = reports.filter((report) => report.best && report.best.tamil >= args.minTamil);
const snippet = winners.map((report) => ({
  id: report.repo.replace(/[^\w.-]+/g, '_'),
  label: report.repo,
  url: rawUrl(report.repo, report.branch, report.best.file),
  short: report.repo.split('/').pop().replace(/\.m3u8?$/i, '').slice(0, 20),
  note: `${report.best.tamil} Tamil / ${report.best.sports} sports rows verified ${new Date().toISOString().slice(0, 10)}`,
}));
console.log(`\nstaticSources entries for the ${snippet.length} winner(s):`);
console.log(JSON.stringify(snippet, null, 2));

if (args.json) fs.writeFileSync(args.json, JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));

/* ------------------------------------------------------------------ *
 * 6. --audit: health of the sources already in the config
 * ------------------------------------------------------------------ */
if (args.audit) {
  console.log('\nCONFIG SOURCE HEALTH\n');
  const targets = [
    ...(config.staticSources || []).map((source) => ({ kind: 'static', id: source.id || source.url, url: source.url })),
    ...(config.legacySources || []).map((source) => ({
      kind: 'legacy',
      id: `${source.repo}/${source.file}`,
      url: `https://raw.githubusercontent.com/${source.repo}/HEAD/${source.file}`,
    })),
  ];
  const indexRows = await gh(config.index.url).then((parsed) => (Array.isArray(parsed) ? parsed : parsed.sources || parsed.data?.sources || []));
  const byId = new Map(indexRows.map((row) => [row.id, row]));
  for (const id of config.index?.pinned || []) {
    const row = byId.get(id);
    targets.push({ kind: 'pinned', id, url: row?.url || '', missing: !row });
  }
  const rows = await mapLimit(targets, 6, async (target) => {
    if (!target.url) return { ...target, status: 'missing from index' };
    try {
      const text = await fetchText(target.url, { timeoutMs: args.timeoutMs, retries: 0 });
      const entries = parseSource(text);
      const usable = entries.filter((entry) => classify({ ...entry, source: { key: target.id, label: target.id, short: target.id, origin: 'static', priority: 999, familyHint: '' } }, { now: Date.now() }).kind !== 'drop').length;
      return { ...target, status: 'ok', entries: entries.length, usable };
    } catch (error) {
      return { ...target, status: String(error.message).slice(0, 60), entries: 0, usable: 0 };
    }
  });
  for (const row of rows) {
    console.log(`${row.kind.padEnd(7)} ${String(row.status).padEnd(28)} entries=${String(row.entries).padStart(5)} usable=${String(row.usable).padStart(4)}  ${row.id}`);
  }
  const broken = rows.filter((row) => row.status !== 'ok' || row.usable === 0);
  console.log(`\n${broken.length} of ${rows.length} configured sources are dead or contribute nothing:`);
  for (const row of broken) console.log(`  ${row.id}  (${row.status})`);
}
