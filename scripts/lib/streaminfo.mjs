/**
 * Stream fingerprints.
 *
 * The same channel usually arrives as 2-3 streams (a DASH+ClearKey copy from a
 * JioTV dump, an HLS copy from a proxy, ...). Players show only the channel name,
 * so the rows look identical. This module derives a compact tag describing how a
 * stream is delivered, plus structured attributes for the app to group on:
 *
 *   protocol  HLS | DASH | TS        (from the URL, falling back to #KODIPROP)
 *   drm       ClearKey | Widevine | PlayReady | ''   (from #KODIPROP)
 *   source    short label of the upstream feed
 */

const SOURCE_SHORT = {
  'maybetv/Jo': 'Jo',
  'sportlive18/Sportlink-wtf': 'Sportlink',
};

/** @returns {{protocol:string, drm:string, source:string, score:number}} */
export function detectStream(entry, config = {}) {
  const url = String(entry.url || '');
  const props = (entry.props || []).join('\n');
  const manifestType = (props.match(/manifest_type\s*=\s*([a-z0-9]+)/i) || [])[1]?.toLowerCase() || '';

  let protocol = '';
  if (/\.mpd(?:$|\?)/i.test(url) || /\/manifest\.mpd/i.test(url) || manifestType === 'mpd' || manifestType === 'dash') {
    protocol = 'DASH';
  } else if (/\.m3u8(?:$|\?)/i.test(url) || manifestType === 'hls') {
    protocol = 'HLS';
  } else if (/\.ts(?:$|\?)/i.test(url)) {
    protocol = 'TS';
  }

  let drm = '';
  if (/license_type\s*=\s*clearkey/i.test(props)) drm = 'ClearKey';
  else if (/license_type\s*=\s*widevine/i.test(props)) drm = 'Widevine';
  else if (/license_type\s*=\s*playready/i.test(props)) drm = 'PlayReady';

  // Short, human-sized source label: "JioTV+ 32", "Jo/playlist", "hjh-545".
  let source = entry.source?.short || entry.source?.label || entry.source?.key || '';
  const repo = Object.keys(SOURCE_SHORT).find((key) => entry.source?.key?.startsWith(key.replace(/[^\w.-]+/g, '_')));
  if (repo) source = source.replace(repo, SOURCE_SHORT[repo]);
  // Trim the "(id)" / factory suffix some source labels carry, and keep it short
  // enough to stay readable in a channel list.
  source = String(source).replace(/\s*\([^)]*\)\s*$/, '').replace(/\.m3u$/i, '').replace(/\s+/g, ' ').trim();
  if (source.length > 24) source = `${source.slice(0, 23).trimEnd()}…`;

  // Order used when alternates of one channel are listed: the most universally
  // playable stream first (plain HLS, then HLS+ClearKey, then DASH variants).
  const playability = { 'HLS|': 0, 'HLS|ClearKey': 1, '|': 2, 'TS|': 3, 'DASH|': 4, 'DASH|ClearKey': 5 }[`${protocol}|${drm}`] ?? 6;

  return { protocol, drm, source, score: playability };
}

/** "Star Vijay HD [DASH · ClearKey · JioTV+ 32]" */
export function decorateName(entry, config = {}) {
  const tags = config.tags || {};
  if (tags.enabled === false) return entry.name;
  const stream = entry.stream || detectStream(entry, config);
  const parts = [];
  if (tags.protocol !== false && stream.protocol) parts.push(stream.protocol);
  if (tags.drm !== false && stream.drm) parts.push(stream.drm);
  if (tags.source !== false && stream.source) parts.push(stream.source);
  if (!parts.length) return entry.name;
  const separator = tags.separator ?? ' · ';
  return `${entry.name} [${parts.join(separator)}]`;
}
