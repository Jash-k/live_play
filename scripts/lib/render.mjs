/**
 * Playlist rendering. Entries keep the upstream playback properties verbatim
 * (user-agent, referrer, cookie, clearkey) — only characters that would break
 * an M3U parser or an HTTP header are stripped.
 */

function cleanValue(value) {
  return String(value ?? '')
    .replace(/[\r\n"]/g, ' ')
    .replace(/,/g, '%2C')
    .trim();
}

function sanitizeName(name) {
  return String(name || '').replace(/[\r\n]/g, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
}

/** HTTP headers must be Latin-1 even when the upstream author typed emoji. */
export function safeProperty(line) {
  const latin1 = (value) => String(value).replace(/[^\t\x20-\xFF]/g, '').trim();
  if (/^#EXTVLCOPT:http-(?:user-agent|referrer|referer|cookie|extra-headers)=/i.test(line)) {
    const at = line.indexOf('=');
    return line.slice(0, at + 1) + latin1(line.slice(at + 1));
  }
  if (/^#EXTHTTP:/i.test(line)) {
    try {
      const clean = (object) =>
        Object.fromEntries(
          Object.entries(object).map(([key, value]) => [key, value && typeof value === 'object' ? clean(value) : latin1(value)]),
        );
      return `#EXTHTTP:${JSON.stringify(clean(JSON.parse(line.slice(line.indexOf(':') + 1))))}`;
    } catch {
      return line;
    }
  }
  return line;
}

export function renderEntry(entry) {
  const name = sanitizeName(entry.name);
  const attributes = {
    'tvg-id': entry.attrs?.['tvg-id'] || '',
    'tvg-name': name,
    'tvg-logo': entry.attrs?.['tvg-logo'] || '',
    'group-title': entry.group,
    ...(entry.language ? { 'tvg-language': entry.language } : {}),
  };
  const head = Object.entries(attributes)
    .map(([key, value]) => `${key}="${cleanValue(value)}"`)
    .join(' ');
  return [`#EXTINF:-1 ${head},${name}`, ...entry.props.map(safeProperty), entry.url].join('\n');
}

export function renderPlaylist(entries, { title, note, generatedAt, extraLines = [] }) {
  const header = [
    '#EXTM3U',
    `#PLAYLIST:${title}`,
    `#NOTE:${note}`,
    `#GENERATED:${generatedAt}`,
    `#ENTRIES:${entries.length}`,
    ...extraLines,
  ];
  return `${header.join('\n')}\n\n${entries.map(renderEntry).join('\n\n')}\n`;
}
