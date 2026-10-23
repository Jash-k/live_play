/**
 * Offline test suite for the curator.
 *
 * Runs the real orchestrator against a snapshot directory (no network), then
 * asserts the filtering, dedupe, metadata-preservation and safety behaviour.
 *   node scripts/test-curate-live.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseM3U } from './lib/parse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const baseConfig = JSON.parse(fs.readFileSync(path.join(here, 'curate-live.config.json'), 'utf8'));

const FAKE_FUTURE = 4102444800; // 2100-01-01
const FAKE_PAST = 1600000000; // 2020-09-13

const indexJson = {
  version: 1,
  sources: [
    { id: 'src_jio', name: 'Jio fixture', category: 'JioTV', url: 'https://index.example/jio.m3u', type: 'M3U_INLINE_DRM' },
    { id: 'src_json', name: 'JSON fixture', category: 'JioTV', url: 'https://index.example/channels.json', type: 'JSON_WRAPPED' },
    { id: 'fancode_events', name: 'Fancode events fixture', category: 'Sports', url: 'https://index.example/events.json', type: 'JSON_WRAPPED' },
    { id: 'src_discover_ok', name: 'Discovery hit', category: 'LiveTV', url: 'https://index.example/hit.m3u', type: 'M3U_DIRECT' },
    { id: 'src_discover_empty', name: 'Discovery miss', category: 'AIO', url: 'https://index.example/miss.m3u', type: 'M3U_DIRECT' },
    { id: 'src_dead', name: 'Dead source', category: 'Sports', url: 'https://index.example/dead.m3u', type: 'M3U_DIRECT' },
  ],
};

const jioFixture = `#EXTM3U
#EXTINF:-1 tvg-language="Tamil",Sun TV HD
https://fixture.example/sun.m3u8
#EXTINF:-1 tvg-id="368" tvg-language="Tamil",Sun TV HD
https://fixture.example/sun.m3u8
#EXTINF:-1 group-title="Tamil" tvg-id="368" tvg-logo="https://fixture.example/vijay.png",Star Vijay HD
#KODIPROP:inputstream.adaptive.license_type=clearkey
#KODIPROP:inputstream.adaptive.license_key=00112233:ffeeddcc
#EXTVLCOPT:http-user-agent=Droovy🙂
https://fixture.example/vijay.mpd
#EXTINF:-1 group-title="Entertainment",Zee Tamil
https://fixture.example/zee.m3u8
#EXTINF:-1 group-title="Entertainment",KTV
https://fixture.example/ktv.m3u8
#EXTINF:-1 group-title="Tamil FM Radio",Big FM Chennai
https://fixture.example/fm.m3u8
#EXTINF:-1 group-title="Tamil",hghk
https://fixture.example/junk.m3u8
#EXTINF:-1 tvg-language="Hindi",Star Sports 1 Hindi
https://fixture.example/hindi.m3u8
#EXTINF:-1 tvg-language="Telugu",Gemini TV
https://fixture.example/telugu.m3u8
#EXTINF:-1 tvg-language="Tamil",Bigboss 24/7 live-TAMIL
https://fixture.example/bb-tamil.m3u8
#EXTINF:-1 tvg-language="Hindi",Bigboss 24/7 live-HINDI
https://fixture.example/bb-hindi.m3u8
#EXTINF:-1 tvg-language="English",Star Sports 1 HD
https://static.example/stream?id=starsports1hd
#EXTINF:-1 tvg-language="Tamil",Sony Ten 4 Tamil
https://fixture.example/sony4.m3u8
#EXTINF:-1 tvg-language="Hindi",Sony Ten 4 Hindi
https://fixture.example/sony4-hindi.m3u8
#EXTINF:-1,Willow Cricket
https://fixture.example/willow.m3u8
#EXTINF:-1,Prime Video Sports Event
https://fixture.example/prime.m3u8
#EXTINF:-1 tvg-language="English",Star Sports Expired
https://fixture.example/expired.m3u8?exp=${FAKE_PAST}
#EXTINF:-1 tvg-language="English",Star Sports Raw
https://fixture.example/raw.ts
#EXTINF:-1 tvg-language="Tamil",Star Vijay
https://fixture.example/vijay-alt1.m3u8
#EXTINF:-1 tvg-language="Tamil",Star Vijay
https://fixture.example/vijay-alt2.m3u8
#EXTINF:-1 tvg-language="Tamil",Star Vijay
https://fixture.example/vijay-alt3.m3u8
`;

const jsonFixture = JSON.stringify([
  {
    type: 'dash',
    id: '290',
    name: 'sonic Tamil',
    group: 'Tamil',
    language: 'Hindi',
    logo: 'https://fixture.example/sonic.png',
    user_agent: 'plaYtv/7.1.3',
    mpd_url: 'https://fixture.example/sonic.mpd',
    license_url: 'https://fixture.example/key?id=290',
    headers: { cookie: `__hdnea__=exp=${FAKE_FUTURE}` },
  },
  { id: '143', name: 'CNBC TV18 Prime', group: 'English', url: 'https://fixture.example/cnbc.mpd', keyId: 'aa', key: 'bb' },
  { id: '999', name: 'Sun Music HD', group: 'Tamil', url: 'https://fixture.example/sunmusic.mpd', keyId: 'cc', key: 'dd', expires_in: String(FAKE_PAST) },
]);

const eventFixture = JSON.stringify({
  matches: [
    {
      event_category: 'Football',
      match_id: '4249597_ENG',
      match_name: 'Bolton Wanderers vs Middlesbrough [English]',
      dai_url: 'https://fixture.example/fancode.m3u8',
      user_agent: 'Mozilla/5.0 fixture',
    },
    { event_category: 'Cricket', match_id: 'x1', event_name: 'Metadata only event', audioLanguageName: 'ENG' },
  ],
});

const discoverOk = `#EXTM3U
#EXTINF:-1 tvg-language="Tamil",Jaya TV HD
https://fixture.example/jaya.m3u8
#EXTINF:-1 tvg-language="Tamil",Kalaignar TV
https://fixture.example/kalaignar.m3u8
#EXTINF:-1 tvg-language="Tamil",Puthiya Thalaimurai
https://fixture.example/puthiya.m3u8
`;

const staticFixture = `#EXTM3U
#EXTINF:-1 tvg-id="1" group-title="Tamil",Raj Digital Plus
#KODIPROP:inputstream.adaptive.manifest_type=mpd
#KODIPROP:inputstream.adaptive.license_type=clearkey
#KODIPROP:inputstream.adaptive.license_key=abc123:def456
https://static.example/stream?id=rajdigitalplus
#EXTINF:-1 tvg-id="2" group-title="Sports",Star Sports 1 HD
https://static.example/stream?id=starsports1hd
`;

const discoverEmpty = `#EXTM3U
#EXTINF:-1 tvg-language="Hindi",Aaj Tak
https://fixture.example/aajtak.m3u8
#EXTINF:-1 tvg-language="Telugu",ETV Telugu
https://fixture.example/etv.m3u8
`;

function writeSnapshot(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_index.json'), JSON.stringify(indexJson));
  fs.writeFileSync(path.join(dir, 'src_jio.m3u'), jioFixture);
  fs.writeFileSync(path.join(dir, 'src_static'), staticFixture);
  fs.writeFileSync(path.join(dir, 'src_json.json'), jsonFixture);
  fs.writeFileSync(path.join(dir, 'fancode_events.json'), eventFixture);
  fs.writeFileSync(path.join(dir, 'src_discover_ok'), discoverOk);
  fs.writeFileSync(path.join(dir, 'src_discover_empty'), discoverEmpty);
}

function testConfig(overrides = {}) {
  const config = {
    ...baseConfig,
    legacySources: [],
    staticSources: [{ id: 'src_static', label: 'Direct fixture feed', url: 'https://index.example/static.m3u' }],
    index: {
      ...baseConfig.index,
      pinned: ['src_jio', 'src_json', 'fancode_events', 'src_dead'],
      autoDiscover: true,
      autoDiscoverMinTamil: 3,
      autoDiscoverMinSports: 1,
      autoDiscoverSkip: {},
      ...overrides.index,
    },
    safety: { ...baseConfig.safety, minMainEntries: 5, minOkSources: 2, maxAlternatesPerChannel: 2, ...overrides.safety },
  };
  return config;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jash-curation-'));
try {
  const snapshot = path.join(temp, 'sources');
  const output = path.join(temp, 'output');
  const configPath = path.join(temp, 'config.json');
  writeSnapshot(snapshot);
  fs.writeFileSync(configPath, JSON.stringify(testConfig(), null, 2));

  execFileSync(process.execPath, [path.join(here, 'curate-live.mjs'), '--config', configPath, '--snapshot', snapshot, '--out', output], { stdio: 'pipe' });

  const read = (file) => fs.readFileSync(path.join(output, file), 'utf8');
  const mainText = read('jash-live.m3u');
  const reviewText = read('jash-review.m3u');
  const stats = JSON.parse(read('jash-live.stats.json'));
  const reviewJson = JSON.parse(read('jash-review.json'));
  const main = parseM3U(mainText);
  const review = parseM3U(reviewText);
  // Channel names carry a stream fingerprint suffix ("Star Vijay HD [DASH · ClearKey · ...]"),
  // so assertions compare the base name and check the tag separately.
  const base = (value) => String(value).replace(/\s*\[[^\]]*\]\s*(?:\(\d+\))?$/, '').trim();
  const names = main.map((entry) => base(entry.name));
  const groups = main.map((entry) => entry.attrs['group-title']);

  // --- Tamil catalogue -------------------------------------------------
  assert(names.includes('Sun TV HD'), 'language-tagged Tamil channel kept');
  assert(names.includes('Star Vijay HD'), 'JioTV group="Tamil" channel kept');
  assert(names.includes('Zee Tamil'), 'brand-name Tamil channel kept');
  assert(names.includes('KTV'), 'short brand name survives the name sanity filter');
  assert(names.includes('Jaya TV HD'), 'auto-discovered source contributes Tamil channels');
  assert(names.includes('sonic Tamil'), 'JSON source normalised into an entry');
  assert(names.includes('Raj Digital Plus'), 'direct/static source contributes channels');
  assert.strictEqual(main.filter((entry) => base(entry.name) === 'Star Sports 1 HD').length, 1, 'same stream URL from two sources becomes one entry');
  assert(main.find((entry) => base(entry.name) === 'Star Sports 1 HD').url.includes('static.example'), 'higher-priority static source wins the duplicate');
  assert(stats.staticSources.some((source) => source.id === 'src_static' && source.used >= 2), 'stats report static source usage');
  assert(groups.includes('Tamil - Entertainment'), 'Tamil channels grouped by category');
  assert(!names.some((name) => /Big FM|hghk/.test(name)), 'radio and junk rows dropped');
  assert(!names.some((name) => /Gemini|CNBC|Aaj Tak|ETV Telugu/.test(name)), 'non-Tamil regional channels dropped');
  assert(!names.some((name) => /Big FM|hghk/.test(name)), 'radio/junk rows never reach the catalogue');

  // --- Stream fingerprint tags ----------------------------------------
  assert(/\[DASH · ClearKey · src_static\]$/.test(main.find((entry) => base(entry.name) === 'Raj Digital Plus').name), 'tag shows protocol, DRM and source');
  const biggBoss = main.find((entry) => entry.attrs['group-title'] === 'Bigg Boss Tamil 24/7');
  assert(/\[HLS · Jio fixture\]$/.test(biggBoss.name), 'plain HLS feed tagged with source but no DRM part');
  assert(main.some((entry) => entry.name === 'Star Sports 1 HD [src_static]'), 'opaque URL with unknown protocol still names its source');
  const tagged = main.map((entry) => entry.name);
  assert.strictEqual(new Set(tagged).size, tagged.length, 'every published channel name is unique');
  for (const entry of main) {
    const type = entry.attrs['stream-type'];
    assert(type === undefined || type === 'HLS' || type === 'DASH', 'stream-type attribute is sane when present');
    assert(entry.attrs['base-name'], 'base-name attribute kept for grouping');
    assert(!/\[(?:HLS|DASH|TS)[ ·\]]/.test(entry.attrs['base-name']), 'base-name is free of stream tags');
  }
  assert(main.filter((entry) => entry.attrs['stream-type']).length > main.length / 2, 'most entries expose a stream-type attribute');

  // --- Bigg Boss -------------------------------------------------------
  assert(names.includes('Bigg Boss Tamil 24/7'), 'Bigg Boss Tamil renamed into its own bucket');
  assert.strictEqual(groups[0], 'Bigg Boss Tamil 24/7', 'Bigg Boss listed first');
  assert(!/live-HINDI/.test(mainText), 'non-Tamil Bigg Boss excluded');

  // --- Sports ----------------------------------------------------------
  assert(main.some((entry) => base(entry.name) === 'Star Sports 1 HD' && entry.attrs['group-title'] === 'Sports - Star Sports - English'));
  assert(main.some((entry) => base(entry.name).includes('Sony Ten 4') && entry.attrs['tvg-language'] === 'Tamil'));
  assert(!/Sony Ten 4 Hindi|Star Sports 1 Hindi/.test(mainText), 'Hindi-labelled sports feeds dropped');
  assert(main.some((entry) => entry.attrs['group-title'] === 'Sports - FanCode - English'), 'English JSON event feed kept');
  assert(main.some((entry) => base(entry.name) === 'Willow Cricket' && entry.attrs['tvg-language'] === 'English'), 'asserted-English brand accepted without a label');
  assert(review.some((entry) => base(entry.name) === 'Prime Video Sports Event'), 'unlabelled non-asserted sports feed queued for review');
  assert(!review.some((entry) => /Metadata only event/.test(entry.name)), 'metadata-only event without a stream is skipped');
  assert(!/expired\.m3u8|raw\.ts/.test(mainText + reviewText), 'expired and raw-container streams dropped');

  // --- Metadata preservation ------------------------------------------
  const vijay = main.find((entry) => base(entry.name) === 'Star Vijay HD');
  assert(vijay.props.some((prop) => prop.startsWith('#KODIPROP:inputstream.adaptive.license_key=00112233')), 'clearkey retained');
  assert(vijay.props.includes('#EXTVLCOPT:http-user-agent=Droovy'), 'emoji stripped from UA header only');
  const sonic = main.find((entry) => base(entry.name) === 'sonic Tamil');
  assert(sonic.props.some((prop) => prop.includes('license_key=https://fixture.example/key?id=290')), 'JSON license URL retained');
  assert(sonic.props.some((prop) => prop.startsWith('#EXTVLCOPT:http-cookie=__hdnea__')), 'JSON headers converted to props');

  // --- Dedupe ----------------------------------------------------------
  assert.strictEqual(main.filter((entry) => base(entry.name) === 'Star Vijay HD').length, 1, 'storm of identical stream URLs collapses to one');
  assert(main.filter((entry) => /^Star Vijay/.test(base(entry.name))).length <= 2, 'alternate streams capped by maxAlternatesPerChannel');
  const urls = main.map((entry) => entry.url);
  assert.strictEqual(new Set(urls).size, urls.length, 'no duplicate URLs in the published feed');

  // --- Stats / reporting ----------------------------------------------
  assert(stats.main.total === main.length, 'stats total matches playlist');
  assert(stats.main.biggBoss === 1, 'stats counts Bigg Boss entries');
  assert(stats.dropped['expired token'] >= 2, 'expiry drops recorded');
  assert(stats.sources.some((source) => source.key === 'fancode_events' && source.matched === 1), 'event source family hint applied');
  assert(stats.dropped['radio/audio channel'] >= 1, 'radio drops recorded');
  assert(stats.index.discovered.includes('src_discover_ok'), 'discovery hit recorded');
  assert(!stats.index.discovered.includes('src_discover_empty'), 'discovery miss not adopted');
  assert(stats.sources.some((source) => source.key === 'src_dead' && !source.ok), 'dead source reported, not fatal');
  assert(reviewJson.some((entry) => entry.name === 'Prime Video Sports Event' && /label/.test(entry.reason)), 'review report explains why');
  assert(stats.main.assertedLanguage >= 1, 'asserted-language rows are counted in stats');
  assert(stats.main.streamTypes.protocol.HLS >= 1 && stats.main.streamTypes.protocol.DASH >= 1, 'stats count stream protocols');
  assert(stats.main.streamTypes.drm.ClearKey >= 1 && stats.main.streamTypes.drm.none >= 1, 'stats count DRM types');
  assert(stats.main.channelsWithAlternates >= 1, 'stats count channels that have alternates');

  // --- Validator -------------------------------------------------------
  const validation = spawnSync(process.execPath, [path.join(here, 'validate.mjs'), '--dir', output, '--config', configPath], { encoding: 'utf8' });
  assert.strictEqual(validation.status, 0, `validator should pass: ${validation.stderr}`);

  // --- Safety gate -----------------------------------------------------
  const strictConfig = path.join(temp, 'strict.json');
  fs.writeFileSync(strictConfig, JSON.stringify(testConfig({ safety: { minMainEntries: 999 } }), null, 2));
  const strictOut = path.join(temp, 'strict-output');
  const strict = spawnSync(process.execPath, [path.join(here, 'curate-live.mjs'), '--config', strictConfig, '--snapshot', snapshot, '--out', strictOut], { encoding: 'utf8' });
  assert.notStrictEqual(strict.status, 0, 'safety gate blocks a thin feed');
  assert(!fs.existsSync(path.join(strictOut, 'jash-live.m3u')), 'existing output is preserved when the gate trips');

  console.log('PASS: Tamil channel detection, radio/junk/regional exclusion, Bigg Boss Tamil only,');
  console.log('      sports language rules, review queue, JSON normalisation, dedupe, metadata retention,');
  console.log('      stream tags + unique names, stats, validator and safety gate');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
