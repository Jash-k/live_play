/**
 * Upstream parsers.
 *
 * Community sources publish two shapes:
 *   1. M3U playlists (#EXTINF + #KODIPROP/#EXTVLCOPT/#EXTHTTP + URL)
 *   2. JSON channel/event dumps (JioTV arrays, FanCode/SonyLIV event objects)
 *
 * Both are normalised into a single entry shape:
 *   { name, attrs, props, url, origin, upstreamGroup }
 * where `props` keeps playback metadata (#KODIPROP / #EXTVLCOPT / #EXTHTTP)
 * exactly as published. The curator never obtains, edits or invents keys.
 */

const ATTRIBUTE_RE = /([\w-]+)="([^"]*)"/g;
const PROPERTY_RE = /^#(?:KODIPROP|EXTVLCOPT|EXTHTTP|EXTVLCOPT):/i;

export function parseAttributes(line) {
  const out = {};
  for (const match of line.matchAll(ATTRIBUTE_RE)) out[match[1].toLowerCase()] = match[2];
  return out;
}

const JUNK_TITLE = /[="]|\/\/|\.(?:jpe?g|png|webp|gif|avif)\b/i;

/** Last-resort repair for rows whose attributes were published unquoted. */
function repairTitle(title) {
  let value = title;
  if (value.includes('="')) value = value.slice(value.lastIndexOf('"') + 1);
  const image = value.match(/.*\.(?:jpe?g|png|webp|gif|avif)["'\s=]/i);
  if (image) value = value.slice(image[0].length);
  return value
    .replace(/^[\s"'=|,:;-]+/, '')
    .replace(/\s+by\s+@\S+/gi, '')
    .replace(/\s*\[(?:not\s*24\/?7|geo-?blocked|offline)\]\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Comma-splitting that respects quotes, so commas inside attributes survive. */
export function parseTitle(line) {
  const body = line.replace(/^#EXTINF:\s*-?[\d.]*\s*/i, '');
  const commas = [];
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '"') quoted = !quoted;
    else if (body[i] === ',' && !quoted) commas.push(i);
  }
  if (!commas.length) return '';
  let raw = body.slice(commas[0] + 1);
  // Some sources ship unquoted attribute values containing commas, which drags
  // part of the attribute list into the title. Re-split from the last comma then.
  if (JUNK_TITLE.test(raw) && commas.length > 1) raw = body.slice(commas[commas.length - 1] + 1);
  return repairTitle(raw);
}

export function parseM3U(text) {
  const entries = [];
  let current = null;
  const flush = () => {
    if (current?.url) entries.push(current);
    current = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      flush();
      current = {
        name: parseTitle(line),
        attrs: parseAttributes(line),
        props: [],
        url: '',
      };
    } else if (current && PROPERTY_RE.test(line)) {
      current.props.push(line);
    } else if (current && !current.url && /^https?:\/\//i.test(line)) {
      current.url = line;
    }
  }
  flush();
  return entries;
}

const CLEARKEY_PROP = (type, key) => [
  `#KODIPROP:inputstream.adaptive.license_type=${type}`,
  `#KODIPROP:inputstream.adaptive.license_key=${key}`,
];

/** Build the playback props for a JioTV-style JSON record. */
function jsonProps(record, streamUrl) {
  const props = [];
  const headers = record.headers && typeof record.headers === 'object' ? record.headers : {};
  const ua = record.user_agent || record['user-agent'] || record.defaultUserAgent;
  if (ua) props.push(`#EXTVLCOPT:http-user-agent=${ua}`);
  if (headers.referer || headers.referrer) props.push(`#EXTVLCOPT:http-referrer=${headers.referer || headers.referrer}`);
  if (headers.cookie) props.push(`#EXTVLCOPT:http-cookie=${headers.cookie}`);
  const extra = { ...headers };
  delete extra.referer; delete extra.referrer; delete extra.cookie; delete extra['user-agent'];
  if (Object.keys(extra).length) props.push(`#EXTHTTP:${JSON.stringify(extra)}`);
  if (record.license_url) {
    // Manifest URL of a key service: keep it as published, players resolve the key.
    props.push('#KODIPROP:inputstream.adaptive.license_type=clearkey');
    props.push(`#KODIPROP:inputstream.adaptive.license_key=${record.license_url}`);
  } else if (record.keyId && record.key) {
    props.push(...CLEARKEY_PROP('clearkey', `${record.keyId}:${record.key}`));
  }
  if (/\.mpd(?:$|\?)/i.test(streamUrl)) props.push('#KODIPROP:inputstream=inputstream.adaptive');
  return props;
}

/** JioTV-style array: `[{name, url|mpd_url, keyId/key|license_url, group|category}]` */
function parseChannelArray(records) {
  const entries = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const url = record.url || record.mpd_url || record.stream_url || record.hls_url || '';
    if (!/^https?:\/\//i.test(url)) continue;
    entries.push({
      name: String(record.name || record.title || '').trim(),
      attrs: {
        'tvg-id': record.id != null ? String(record.id) : '',
        'tvg-logo': record.logo || record.image || '',
        // `group` is the language/category label on these dumps; `language` is
        // frequently stale (e.g. "Hindi" on a Tamil channel), so it is only a fallback.
        'group-title': String(record.group || record.category || ''),
      },
      props: jsonProps(record, url),
      url,
      // Epoch expiry published alongside the stream (JioTV dumps). Values that
      // look like a duration instead of a timestamp are ignored by the curator.
      expires: Number(record.expires_in || record.expires || 0) || 0,
    });
  }
  return entries;
}

/** FanCode / SonyLIV style: `{matches:[{match_name,title,dai_url,audioLanguageName}]}` */
function parseEventObject(object) {
  const matches = Array.isArray(object.matches) ? object.matches : Array.isArray(object.events) ? object.events : [];
  const entries = [];
  for (const match of matches) {
    if (!match || typeof match !== 'object') continue;
    const url = match.dai_url || match.adfree_url || match.stream_url || match.url || '';
    if (!/^https?:\/\//i.test(url)) continue; // SonyLIV metadata-only rows: no stream to publish
    const language = String(match.audioLanguageName || match.audio_language || '').toUpperCase();
    const name = String(match.match_name || match.title || match.event_name || '').trim();
    const props = [];
    const ua = match.user_agent || match['user-agent'];
    if (ua) props.push(`#EXTVLCOPT:http-user-agent=${ua}`);
    entries.push({
      name,
      isEvent: true,
      attrs: {
        'tvg-id': String(match.match_id || match.contentId || ''),
        'tvg-logo': match.src || '',
        'group-title': String(match.event_category || ''),
        ...(language === 'TAM' ? { 'tvg-language': 'Tamil' } : language === 'ENG' ? { 'tvg-language': 'English' } : {}),
      },
      props,
      url,
    });
  }
  return entries;
}

/**
 * Parse whatever an upstream source returns. Returns an empty array for
 * shapes we do not understand (HTML landing pages, empty playlists, ...).
 */
export function parseSource(text) {
  const trimmed = text.trim().replace(/^\uFEFF/, '');
  if (!trimmed) return [];
  if (/^[[{]/.test(trimmed)) {
    try {
      const json = JSON.parse(trimmed);
      if (Array.isArray(json)) return parseChannelArray(json);
      if (json && typeof json === 'object') return parseEventObject(json);
    } catch {
      return [];
    }
  }
  return parseM3U(trimmed);
}
