/**
 * Group taxonomy — one source of truth for curator and validator.
 *
 * The curator decides which `group-title` an entry gets; the validator rejects
 * anything outside the catalogue. Both used to derive that catalogue inline, so
 * the two could drift apart. They did: `tamil.categoryKeywords` mapped
 * "sports" -> "Sports", a category `tamil.categoryOrder` never listed, so a
 * Tamil-labelled row from an upstream group called "Sports" was published as
 * "Tamil - Sports" and the validator failed the run with
 * `unexpected group "Tamil - Sports"`.
 *
 * Everything below is derived from the config, and `configProblems()` makes the
 * drift detectable offline (see scripts/test-curate-live.mjs).
 */

const UNKNOWN_LANGUAGE = 'Language unknown';

/** Every `group-title` the published playlists are allowed to contain. */
export function allowedGroups(config) {
  const groups = new Set([config.groups.biggBoss, config.groups.review]);
  for (const category of config.tamil?.categoryOrder || []) {
    groups.add(`${config.groups.tamilPrefix}${category}`);
  }
  for (const family of Object.keys(config.sports?.families || {})) {
    for (const language of [...(config.sports?.languages || []), UNKNOWN_LANGUAGE]) {
      groups.add(`${config.groups.sportsPrefix}${family} - ${language}`);
    }
  }
  return groups;
}

/**
 * Group order used when rendering: Bigg Boss, Tamil categories in config order,
 * then sports families (Tamil before English before unknown), review last.
 */
export function groupRanks(config) {
  const ranks = new Map();
  ranks.set(config.groups.biggBoss, 0);
  (config.tamil?.categoryOrder || []).forEach((category, order) => {
    ranks.set(`${config.groups.tamilPrefix}${category}`, order + 1);
  });
  Object.keys(config.sports?.families || {})
    .filter((family) => family !== 'Bigg Boss')
    .forEach((family, order) => {
      ranks.set(`${config.groups.sportsPrefix}${family} - Tamil`, 100 + order * 2);
      ranks.set(`${config.groups.sportsPrefix}${family} - English`, 101 + order * 2);
      ranks.set(`${config.groups.sportsPrefix}${family} - ${UNKNOWN_LANGUAGE}`, 101 + order * 2);
    });
  ranks.set(config.groups.review, 9999);
  return ranks;
}

/**
 * Config self-consistency. Returns one message per way the config could make
 * the curator emit a group the validator will reject (or vice versa).
 */
export function configProblems(config) {
  const problems = [];
  const allowed = allowedGroups(config);
  const order = new Set(config.tamil?.categoryOrder || []);

  for (const [keyword, category] of Object.entries(config.tamil?.categoryKeywords || {})) {
    if (!order.has(category)) {
      problems.push(
        `tamil.categoryKeywords["${keyword}"] -> "${category}" is not in tamil.categoryOrder, ` +
          `so rows matched by it would be published as "${config.groups.tamilPrefix}${category}" and rejected`,
      );
    }
  }
  for (const category of Object.keys(config.tamil?.brands || {})) {
    if (!order.has(category)) {
      problems.push(`tamil.brands has category "${category}" which is not in tamil.categoryOrder`);
    }
  }
  const defaultCategory = config.tamil?.defaultCategory;
  if (!defaultCategory || !order.has(defaultCategory)) {
    problems.push(`tamil.defaultCategory "${defaultCategory}" is not in tamil.categoryOrder`);
  }
  if (!allowed.has(config.groups.biggBoss)) problems.push('groups.biggBoss is not derivable');
  if (!allowed.has(config.groups.review)) problems.push('groups.review is not derivable');
  return problems;
}
