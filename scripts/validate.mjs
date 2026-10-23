#!/usr/bin/env node
/**
 * Playlist validator — runs in CI after the curator and can be run manually:
 *   node scripts/validate.mjs [--dir .] [--config scripts/curate-live.config.json]
 *
 * Checks structure (not playback): every entry has one https URL, known groups,
 * no duplicate streams and no expired tokens in the published file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseM3U } from './lib/parse.mjs';

const argv = process.argv.slice(2);
let dir = '.';
let configPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'curate-live.config.json');
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dir') dir = argv[++i];
  else if (argv[i] === '--config') configPath = argv[++i];
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const errors = [];
const warnings = [];

function check(filePath, { expectEntries }) {
  const name = path.basename(filePath);
  if (!fs.existsSync(filePath)) {
    errors.push(`${name}: missing`);
    return [];
  }
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.startsWith('#EXTM3U')) errors.push(`${name}: missing #EXTM3U header`);

  const lines = text.split(/\r?\n/);
  const seen = new Set();
  const seenNames = new Set();
  const entries = parseM3U(text);
  let extinf = 0;
  let pending = null;
  lines.forEach((line, index) => {
    if (line.startsWith('#EXTINF:')) {
      extinf++;
      pending = index + 1;
    } else if (pending && /^https?:\/\//i.test(line.trim())) {
      pending = null;
    } else if (pending && (line.startsWith('#EXTINF:') === false) && line.trim() && !/^#(?:KODIPROP|EXTVLCOPT|EXTHTTP):/i.test(line)) {
      errors.push(`${name}:${index + 1}: unexpected line between EXTINF and URL`);
      pending = null;
    }
  });

  if (extinf !== entries.length) errors.push(`${name}: ${extinf} #EXTINF lines but only ${entries.length} parsed entries`);
  if (expectEntries && !entries.length) errors.push(`${name}: no entries`);
  if (!expectEntries && entries.length) warnings.push(`${name}: ${entries.length} entries in the review queue`);

  const now = Date.now();
  for (const entry of entries) {
    const where = `${name}: ${entry.name || '(unnamed)'}`;
    if (!entry.name) errors.push(`${where}: empty channel name`);
    if (!entry.attrs['group-title']) errors.push(`${where}: missing group-title`);
    if (!/^https:\/\//i.test(entry.url)) errors.push(`${where}: non-https URL`);
    if (/\.(?:ts|flv|mkv|avi)(?:$|[?&|])/i.test(entry.url)) errors.push(`${where}: raw container URL`);
    const stream = entry.url.split('|')[0];
    if (seen.has(stream)) errors.push(`${where}: duplicate stream URL`);
    seen.add(stream);

    // Two alternates of one channel must be distinguishable in the player.
    const nameKey = `${entry.attrs['group-title']}|${entry.name}`;
    if (seenNames.has(nameKey)) errors.push(`${where}: duplicate channel name in this group (add a stream tag)`);
    seenNames.add(nameKey);

    // Stream fingerprints: present, or explicitly unknown for opaque proxy URLs.
    const type = entry.attrs['stream-type'];
    if (type && !['HLS', 'DASH', 'TS'].includes(type)) errors.push(`${where}: unexpected stream-type "${type}"`);
    if (type === 'DASH' && !/\.mpd|manifest\.mpd/i.test(entry.url) && !entry.props.some((prop) => /manifest_type\s*=\s*(mpd|dash)/i.test(prop))) {
      warnings.push(`${where}: DASH tag without a manifest hint`);
    }
    for (const match of [entry.url, ...entry.props].join(' ').matchAll(/(?:exp|expires)(?:=|%3D)(\d{10})(?!\d)/gi)) {
      if (Number(match[1]) * 1000 < now) warnings.push(`${where}: expired token published`);
    }
  }
  return entries;
}

const mainEntries = check(path.join(dir, config.output.main), { expectEntries: true });
check(path.join(dir, config.output.review), { expectEntries: false });

const allowedGroups = new Set([config.groups.biggBoss, config.groups.review]);
(config.tamil.categoryOrder || []).forEach((category) => allowedGroups.add(`${config.groups.tamilPrefix}${category}`));
for (const family of Object.keys(config.sports.families)) {
  for (const language of [...config.sports.languages, 'Language unknown']) {
    allowedGroups.add(`${config.groups.sportsPrefix}${family} - ${language}`);
  }
}
for (const entry of mainEntries) {
  if (entry.attrs['group-title'] && !allowedGroups.has(entry.attrs['group-title'])) {
    errors.push(`${config.output.main}: unexpected group "${entry.attrs['group-title']}"`);
  }
}

const tamil = mainEntries.filter((entry) => (entry.attrs['group-title'] || '').startsWith(config.groups.tamilPrefix)).length;
const biggBoss = mainEntries.filter((entry) => entry.attrs['group-title'] === config.groups.biggBoss).length;
const sports = mainEntries.length - tamil - biggBoss;
if (!tamil) errors.push(`${config.output.main}: no Tamil channel groups`);
if (!biggBoss) warnings.push(`${config.output.main}: no Bigg Boss Tamil feed this refresh`);

const withTags = mainEntries.filter((entry) => entry.attrs['stream-type']).length;
const summary = `${mainEntries.length} main entries (${tamil} Tamil, ${biggBoss} Bigg Boss, ${sports} sports, ${withTags} with a stream tag)`;
for (const warning of [...new Set(warnings)]) console.warn(`warn: ${warning}`);
if (errors.length) {
  for (const error of [...new Set(errors)]) console.error(`error: ${error}`);
  console.error(`FAILED: ${summary}, ${errors.length} error(s)`);
  process.exit(1);
}
console.log(`PASS: ${summary}`);
