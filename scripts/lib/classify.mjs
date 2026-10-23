/**
 * Channel classification.
 *
 * The curator answers three questions per upstream entry:
 *   1. Is this a Tamil-language channel?  (name / language metadata / brand table)
 *   2. Which catalogue does it belong to? (Tamil category, Bigg Boss, or sports brand)
 *   3. Is the stream usable at all?       (scheme, container, expiry)
 *
 * Guessing is deliberately avoided: a sports feed with no Tamil/English label
 * goes to the review playlist instead of being relabelled. The single exception
 * is `sports.assertedEnglish`, an explicit maintainer-authored list of feeds
 * whose language is known (Star Sports 1/2, Sony Ten 1/2/5, ...). Every entry
 * accepted that way is flagged `asserted: true` in the stats file.
 */

export const LANGUAGES = [
  'tamil', 'telugu', 'hindi', 'kannada', 'malayalam', 'bengali', 'bangla',
  'marathi', 'gujarati', 'punjabi', 'urdu', 'bhojpuri', 'odia', 'oriya',
  'assamese', 'english', 'arabic', 'spanish', 'sinhala', 'nepali', 'konkani',
  'kashmiri', 'sanskrit', 'manipuri', 'tulu', 'french', 'german', 'portuguese',
];

/** Short codes used by event feeds: "Match [ENG]", "[TAM]". */
const ABBREVIATIONS = {
  eng: 'english', en: 'english', tam: 'tamil', ta: 'tamil', hin: 'hindi',
  tel: 'telugu', kan: 'kannada', mal: 'malayalam', ben: 'bengali', mar: 'marathi',
  guj: 'gujarati', pun: 'punjabi', urd: 'urdu', bho: 'bhojpuri',
};

const TAMIL_TOKEN = /\b(?:tamil|tamizh|thamizh)\b/i;
const REGIONAL_DROP = new Set(LANGUAGES.filter((language) => language !== 'tamil' && language !== 'english'));
const QUALITY_TOKENS = /\b(?:hd|sd|fhd|uhd|4k|8k|hevc|hq|1080p|720p|576p|480p|360p|240p)\b/g;

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalize = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[_|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const stripQuality = (value) =>
  normalize(value).replace(/[+&]/g, ' ').replace(QUALITY_TOKENS, ' ').replace(/\s+/g, ' ').trim();

/** Which language does a label refer to, if any? */
function languageIn(value) {
  const text = normalize(value);
  if (!text) return '';
  for (const language of LANGUAGES) {
    if (new RegExp(`(?:^|[^a-z])${language}(?:$|[^a-z])`).test(text)) return language;
  }
  return '';
}

/** Abbreviation form: "[ENG]", "(TAM)", "| HIN". */
function abbreviationIn(value) {
  const text = String(value || '');
  const bracketed = text.match(/[[(|]\s*(eng|en|tam|ta|hin|tel|kan|mal|ben|mar|guj|pun|urd|bho)\s*[\])|]/i);
  if (bracketed) return ABBREVIATIONS[bracketed[1].toLowerCase()] || '';
  const upper = text.match(/(?:^|[^A-Za-z])(ENG|TAM|HIN|TEL|KAN|MAL|BEN|MAR|GUJ|PUN|URD|BHO)(?:$|[^A-Za-z])/);
  return upper ? ABBREVIATIONS[upper[1].toLowerCase()] || '' : '';
}

/** Names like "hghk" are noise in a hand-curated feed. */
export function looksLikeChannelName(name) {
  const text = stripQuality(name);
  if (text.replace(/[^a-z]/g, '').length < 3) return false;
  if (!/[aeiouy]/.test(text)) return false;
  if (/^https?:/.test(text)) return false;
  return true;
}

export function buildClassifier(config) {
  // Flatten the brand table into ordered matchers: first match wins.
  const brands = [];
  for (const [category, patterns] of Object.entries(config.tamil.brands || {})) {
    for (const pattern of patterns) {
      brands.push({
        category,
        brand: pattern,
        regex: new RegExp(`(?:^|[^a-z0-9])${escapeRegex(normalize(pattern))}(?:$|[^a-z0-9])`, 'i'),
      });
    }
  }

  // Brands that keep showing up inside Tamil-labelled upstream lists but are not
  // Tamil channels. Dropped unless the row itself says Tamil.
  const denied = (config.tamil.denyBrands || []).map(
    (brand) => new RegExp(`(?:^|[^a-z0-9])${escapeRegex(normalize(brand))}(?:$|[^a-z0-9])`, 'i'),
  );

  const groupCategories = Object.entries(config.tamil.categoryKeywords || {}).map(([keyword, category]) => ({
    category,
    regex: new RegExp(`(?:^|[^a-z])${escapeRegex(keyword)}(?:$|[^a-z])`, 'i'),
  }));

  const radioPattern = new RegExp(config.tamil.radioPattern, 'i');
  const junkNamePattern = config.filters?.junkNamePattern ? new RegExp(config.filters.junkNamePattern, 'i') : null;
  const sportsFamilies = Object.entries(config.sports.families || {}).map(([family, patterns]) => ({
    family,
    regex: new RegExp(patterns.join('|'), 'i'),
  }));
  const assertedEnglish = (config.sports.assertedEnglish || []).map((pattern) => new RegExp(pattern, 'i'));

  function categoryFrom(oldGroup, name) {
    for (const brand of brands) {
      if (brand.regex.test(stripQuality(name)) || brand.regex.test(normalize(name))) return brand.category;
    }
    const group = normalize(oldGroup);
    if (group) {
      for (const entry of groupCategories) if (entry.regex.test(group)) return entry.category;
    }
    return config.tamil.defaultCategory;
  }

  function isExpired(entry, now) {
    const epoch = Number(entry.expires || 0);
    if (epoch > 1e9 && epoch < 1e11 && epoch * 1000 < now + 60_000) return true;
    const haystack = [entry.url, ...entry.props].join(' ');
    for (const match of haystack.matchAll(/(?:exp|expires|expires_in)(?:=|%3D|"?:?\s*)(\d{10})(?!\d)/gi)) {
      if (Number(match[1]) * 1000 < now + 60_000) return true;
    }
    return false;
  }

  function unsupportedUrl(url) {
    if (!/^https:\/\//i.test(url)) return 'not https';
    if (/\.(?:ts|flv|mkv|avi|mp3|aac|m4a)(?:$|[?&|])/i.test(url)) return 'raw container or audio-only';
    return '';
  }

  /**
   * @returns {{kind:'main'|'review'|'drop', reason?:string, group?:string, name?:string,
   *            language?:string, family?:string, category?:string, asserted?:boolean}}
   */
  function classify(entry, { now = Date.now() } = {}) {
    const raw = String(entry.name || '');
    const name = normalize(raw);
    const brandTarget = stripQuality(raw);
    const groupTitle = entry.attrs?.['group-title'] || '';
    const tagLanguage = languageIn(entry.attrs?.['tvg-language'] || '') || abbreviationIn(raw);
    const groupLanguage = languageIn(groupTitle) || abbreviationIn(groupTitle);
    const nameLanguage = languageIn(name);
    const spoken = new Set([tagLanguage, groupLanguage, nameLanguage].filter(Boolean));
    const tamilInName = TAMIL_TOKEN.test(name);
    const tamilTagged = tagLanguage === 'tamil' || groupLanguage === 'tamil';
    const regionalInName = REGIONAL_DROP.has(nameLanguage);

    // A row that names another language in its own name is never Tamil, even if
    // the upstream list it came from is labelled Tamil.
    if (!tamilInName && regionalInName) return { kind: 'drop', reason: 'other regional language' };
    if (!tamilInName && denied.some((regex) => regex.test(brandTarget))) {
      return { kind: 'drop', reason: 'other regional language' };
    }

    const brandHit = brands.find((brand) => brand.regex.test(brandTarget) || brand.regex.test(name));
    if (junkNamePattern && junkNamePattern.test(name)) return { kind: 'drop', reason: 'unusable name' };
    if (!brandHit && !looksLikeChannelName(raw)) return { kind: 'drop', reason: 'unusable name' };
    if (unsupportedUrl(entry.url)) return { kind: 'drop', reason: unsupportedUrl(entry.url) };
    if (isExpired(entry, now)) return { kind: 'drop', reason: 'expired token' };

    // Brands may only appear in the upstream group ("Fancode-Football",
    // "Prime Video Sports"), so both the name and the group are matched.
    const familyTarget = `${name} ${normalize(groupTitle)}`;
    const familyHit = sportsFamilies.find((family) => family.regex.test(familyTarget));
    // Event dumps (FanCode/SonyLIV) do not repeat the brand in every row, so the
    // source's own family hint is used for event rows / legacy sports files.
    const hintedFamily = entry.source?.familyHint && (entry.isEvent || entry.source.origin === 'github')
      ? entry.source.familyHint
      : '';

    // ---- Bigg Boss: Tamil only, everything else stays out of the feed. ----
    if (familyHit?.family === 'Bigg Boss') {
      if (tamilInName || tamilTagged) {
        // Stable display name so the app always finds the same "Bigg Boss Tamil 24/7" row.
        return { kind: 'main', family: 'Bigg Boss', language: 'Tamil', group: config.groups.biggBoss, name: config.groups.biggBoss };
      }
      return { kind: 'drop', reason: 'Bigg Boss without Tamil label' };
    }

    // ---- Sports feeds ----
    const effectiveFamily = familyHit?.family || hintedFamily;
    if (effectiveFamily && effectiveFamily !== 'Bigg Boss') {
      if ([...spoken].some((language) => REGIONAL_DROP.has(language))) {
        return { kind: 'drop', reason: 'other regional language' };
      }
      const allowed = config.sports.languages.map((language) => normalize(language));
      let labelled = [...spoken].find((language) => allowed.includes(language));
      let asserted = false;
      if (!labelled && assertedEnglish.some((regex) => regex.test(brandTarget))) {
        labelled = 'english';
        asserted = true;
      }
      if (labelled) {
        const display = labelled.charAt(0).toUpperCase() + labelled.slice(1);
        return {
          kind: 'main',
          family: effectiveFamily,
          language: display,
          asserted,
          group: `${config.groups.sportsPrefix}${effectiveFamily} - ${display}`,
          name: raw,
        };
      }
      return {
        kind: 'review',
        family: effectiveFamily,
        language: '',
        group: config.groups.review,
        name: raw,
        reason: 'sports feed without an explicit Tamil/English label',
      };
    }

    // ---- Tamil channels ----
    const explicitRegional = [...spoken].some((language) => REGIONAL_DROP.has(language));
    if (explicitRegional && !tamilInName && !brandHit && !tamilTagged) {
      return { kind: 'drop', reason: 'other regional language' };
    }
    // "CTV IDC (ENGLISH)" style rows: the feed names its own language, so the
    // brand alone must not pull it into the Tamil catalogue.
    if (nameLanguage === 'english' && !tamilInName && !tamilTagged) return { kind: 'drop', reason: 'not Tamil' };
    const tamil = tamilInName || tamilTagged || Boolean(brandHit);
    if (!tamil) return { kind: 'drop', reason: 'not Tamil' };

    if (!config.tamil.includeRadio && radioPattern.test(`${name} ${normalize(groupTitle)}`)) {
      return { kind: 'drop', reason: 'radio/audio channel' };
    }

    const category = categoryFrom(groupTitle, raw);
    return {
      kind: 'main',
      family: '',
      language: 'Tamil',
      category,
      group: `${config.groups.tamilPrefix}${category}`,
      name: raw,
    };
  }

  return { classify };
}

/**
 * Key used to collapse duplicate rows of the same channel across sources.
 * Quality suffixes and source noise are removed so "Star Vijay", "Star Vijay HD"
 * and "STAR VIJAY (1080p)" collapse into one brand with alternate streams.
 */
export function channelKey(name, group, language) {
  const base = normalize(name)
    .replace(/\((?:1080|720|576|480|360|240)p\)/g, ' ')
    .replace(/\b(?:hd|sd|fhd|uhd|4k|8k|hevc|hq|multi|backup|alternate)\b/g, ' ')
    .replace(/\+/g, ' ')
    .replace(/\b(?:not\s*24\s*7|geo\s*blocked)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, '')
    .trim();
  return `${base}|${normalize(group)}|${normalize(language)}`;
}
