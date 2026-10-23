/**
 * Source resolution.
 *
 * Two kinds of upstream are supported:
 *
 *   index    – the community source index at playlists.dbprojects.workers.dev.
 *              `/api/sources` returns {id, name, category, url, type} rows.
 *              Pinned ids are always fetched; every other row is a discovery
 *              candidate and is only merged when it actually yields Tamil or
 *              Tamil/English sports entries.
 *   github   – the original raw-github playlist files (maybetv/Jo, Sportlink-wtf).
 *
 * A local snapshot directory (SOURCE_SNAPSHOT_DIR) can replace network access,
 * which is how the test suite runs offline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchText } from './net.mjs';

const DEFAULT_INDEX_URL = 'https://playlists.dbprojects.workers.dev/api/sources';

const legacyKey = (source) => `${source.repo.replace(/[^\w.-]+/g, '_')}__${source.file.replace(/[^\w.-]+/g, '_')}`;

function snapshotCandidates(dir, key) {
  return [key, `${key}.m3u`, `${key}.json`, `${key}.txt`].map((name) => path.join(dir, name)).filter((file) => fs.existsSync(file));
}

function familyHintFor(row, hints) {
  const haystack = `${row.id || ''} ${row.name || ''}`.toLowerCase();
  for (const [needle, family] of Object.entries(hints || {})) {
    if (haystack.includes(needle.toLowerCase())) return family;
  }
  return '';
}

function readSnapshot(dir, key) {
  const files = snapshotCandidates(dir, key);
  if (!files.length) throw new Error('no snapshot file');
  return fs.readFileSync(files[0], 'utf8');
}

/** Fetch the source index (network or snapshot). */
export async function loadIndex(config, { snapshotDir, timeoutMs } = {}) {
  const indexUrl = process.env.INDEX_URL || config.index?.url || DEFAULT_INDEX_URL;
  if (snapshotDir) {
    const files = ['_index.json', 'index.json'].map((name) => path.join(snapshotDir, name)).filter((file) => fs.existsSync(file));
    if (!files.length) return { url: indexUrl, rows: [] };
    return { url: indexUrl, rows: JSON.parse(fs.readFileSync(files[0], 'utf8')).sources || [] };
  }
  const text = await fetchText(indexUrl, { timeoutMs: timeoutMs ?? config.index?.timeoutMs ?? 20000, retries: 2 });
  const parsed = JSON.parse(text);
  // The deployed index wraps the catalogue: {sha, data:{version, sources:[...]}}
  const rows = Array.isArray(parsed) ? parsed : parsed.sources || parsed.data?.sources;
  if (!Array.isArray(rows)) throw new Error('source index has no sources[] array');
  return { url: indexUrl, rows };
}

/**
 * @returns {{primary: object[], discovery: object[]}} ordered source descriptors
 */
export function buildSourcePlan(config, indexRows) {
  const plan = { primary: [], discovery: [] };

  (config.legacySources || []).forEach((source, order) => {
    plan.primary.push({
      key: legacyKey(source),
      label: `${source.repo}/${source.file}`,
      origin: 'github',
      priority: order,
      url: `https://raw.githubusercontent.com/${source.repo}/HEAD/${source.file}`,
      familyHint: source.family || '',
    });
  });

  const byId = new Map(indexRows.map((row) => [row.id, row]));
  const pinned = config.index?.pinned || [];
  const legacyPriority = plan.primary.length;

  pinned.forEach((id, order) => {
    const row = byId.get(id);
    if (!row) {
      plan.discovery.push({ key: id, label: id, origin: 'index', priority: 900 + order, url: '', missing: true });
      return;
    }
    plan.primary.push({
      key: row.id,
      label: `${row.name || row.id} (${row.id})`,
      origin: 'index',
      priority: legacyPriority + order,
      url: row.url,
      category: row.category || '',
      type: row.type || '',
      familyHint: familyHintFor(row, config.index?.familyHints),
      defaultUserAgent: row.defaultUserAgent || '',
    });
  });

  if (config.index?.autoDiscover !== false) {
    const skip = config.index?.autoDiscoverSkip || {};
    indexRows
      .filter((row) => !pinned.includes(row.id))
      .forEach((row, order) => {
        plan.discovery.push({
          key: row.id,
          label: `${row.name || row.id} (${row.id})`,
          origin: 'index',
          priority: 500 + order,
          url: row.url,
          category: row.category || '',
          type: row.type || '',
          familyHint: familyHintFor(row, config.index?.familyHints),
          skipped: skip[row.id] || '',
        });
      });
  }

  return plan;
}

export async function readSource(source, { snapshotDir, timeoutMs = 20000, retries = 1 } = {}) {
  if (source.missing) return { ok: false, error: 'not present in source index' };
  try {
    const text = snapshotDir
      ? readSnapshot(snapshotDir, source.key)
      : await fetchText(source.url, { timeoutMs, retries });
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: error.name === 'TimeoutError' ? 'timeout' : String(error.message).slice(0, 120) };
  }
}
