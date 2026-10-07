# Jash Live — Star Sports English HD + Tamil only

This repo used to publish a 300+ row feed (Tamil channels + Bigg Boss + every sports family). It now
publishes **exactly six Star Sports feeds**, English and Tamil, and nothing else:

| # | channel (as it appears in the feed) | language | row |
|---|---|---|---|
| 1 | Star Sports 1 HD | English | HD |
| 2 | Star Sports 2 HD | English | HD |
| 3 | Star Sports 1 Digital | English | SD fallback |
| 4 | Star Sports 2 Digital | English | SD fallback |
| 5 | Star Sports 1 Tamil Digital | Tamil | |
| 6 | Star Sports 2 Tamil Digital | Tamil | |

No Hindi, Telugu, Kannada, Malayalam, Select, Khel or any other regional feed can enter the file: the
allowlist `onlyNames` in `scripts/live-playlist.config.json` is the only door, and the build logs
`Dropped (not in onlyNames)` for everything it turns away.

Every row carries its ClearKey pair (`kid:key`), the Hotstar User-Agent + Referer and an `#EXTHTTP` block —
exactly what jashvibes' Live Service imports natively. All six answered `200` with a matching
`cenc:default_KID` on the day this was written.

**The feed URL does not change:** `https://raw.githubusercontent.com/Jash-k/live_play/main/jash-live.m3u`
— the file name, the path and the app's source entry all stay the same.

## Using it in jashvibes

1. **Admin → TV Service → Sources**: the `Jash-k/live_play` source you already have keeps working. Type
   `m3u` · priority `6` · **trustTamil ON** · autoPurge OFF.
2. **Sync** — it now parses `6` channels.
3. **Channels → Manual mapping**: map them into your catalogs, e.g. all six into **Sports**, and pair
   each HD row with its Digital sibling as an *alternative source* of the same channel (the app's
   logical-channel grouping) so an HD outage falls back to SD instead of going dark.
4. Only mapped channels are published to Live TV.

> **Safari / iPhone**: ClearKey is not supported by Apple's CDMs. These six play in **Chrome, Edge,
> Firefox** (desktop + Android); nothing can be done on this side.

## What changed in the repo

| file | state |
|---|---|
| `.github/workflows/jash-live.yml` | **replaced** — builds the six-row feed, probes all six streams, commits only when content changed |
| `README.md` | **replaced** — this file |
| `scripts/live-playlist.config.json` | **replaced** — the six-channel allowlist, one source (`star-sports.m3u`) |
| `scripts/build-live-playlist.mjs` | **updated** — supports `onlyNames` (allowlist), `keepQualityVariants` (HD + SD sibling survive), repo-local source files first, configurable `title`, and no longer demands a Bigg Boss section when that section is off |
| `jash-live.m3u` / `jash-live.stats.json` | **rebuilt** — 6 rows |
| `star-sports.m3u` | **the source** — 67 verified Star/ESPN rows, kept in the repo so builds are deterministic |
| `tools/live-doctor.mjs` (+ `tools/_vendor/`) | **updated** — a ClearKey feed with no CDN tokens is no longer flagged as "stale after 45 min"; that rule is for expiring-token feeds |
| `scripts/live-playlist.config.full-feed-example.json` | **new** — your previous 43-source Tamil + Bigg Boss + sports config, preserved |

Nothing else was in the repo. If you still have `HOTSTAR-STAR-SPORTS.md`, it is a leftover doc — safe to
keep or delete.

### Going back to the full feed, or merging the two

- **Full feed again**: change the workflow's build step to
  `node scripts/build-live-playlist.mjs --config scripts/live-playlist.config.full-feed-example.json`
  (and the commit step's `git add`, if the output name differs — the example writes the same
  `jash-live.m3u`).
- **Six Star channels *plus* the full feed**: add the 43 sources from the example back into
  `scripts/live-playlist.config.json` and delete the `onlyNames` array — with `onlyNames` present,
  everything outside the allowlist is dropped.

## How the feed is built

```
star-sports.m3u                       ← the only source (67 verified rows, in this repo)
scripts/live-playlist.config.json     ← onlyNames allowlist = the 6 channels
scripts/build-live-playlist.mjs       ← no dependencies, plain Node 20+
        ↓
jash-live.m3u + jash-live.stats.json  ← committed by the workflow when content changed
```

```bash
node scripts/build-live-playlist.mjs            # build (skips writing when unchanged)
node scripts/build-live-playlist.mjs --force    # build even if unchanged
node tools/live-doctor.mjs jash-live.m3u        # probe every row: 0 = healthy, 1 = attention
```

### Changing the channel set

Edit `onlyNames` in `scripts/live-playlist.config.json` — case-insensitive regexes, tested against the raw
name and against the de-duplication name. The source file already holds 67 verified rows, so widening the
list is one line, e.g. add `"^star sports 1 hindi digital$"`, or `"^espn"` for the ESPN rows.

| key | what it does |
|---|---|
| `onlyNames` | the allowlist — nothing outside it can enter the feed |
| `keepQualityVariants` | `true` = an HD row and its SD/Digital sibling both survive (needed for rows 1–4); `false` = only the best row per channel |
| `minChannels` | build fails (red X, file untouched) when fewer rows come out — a guard against publishing a half-empty feed |
| `title` | the `#PLAYLIST:` label inside the file |
| `dropHosts` | URL patterns that may never appear |

## The workflow

Runs on push (when the source/config change), **every 6 hours**, and on demand:

- builds the playlist,
- **probes all six streams** with the live doctor — a channel that stops answering turns the run red,
- commits `jash-live.m3u` + `jash-live.stats.json` **only when the content actually changed**.

This is different from the old 30-minute cron on purpose: the source is a static, token-free ClearKey feed,
so nothing expires on a clock and there is nothing to chase every half hour. The cron is now a health
check. If the six rows ever need replacing, edit `star-sports.m3u` and push — the build picks it up.

Two things that still hold true:

- keep the workflow at the **repo root** `.github/workflows/` — a nested copy is silently ignored;
- if any *other* workflow in this repo also writes `jash-live.m3u`, delete it. Only one writer.

## Where the rows come from

`star-sports.m3u` is a snapshot of the Hotstar-family rows proxied by
`shoeblive.com/jh/hot.php/<Channel>.mpd` — the same source the stream4liv site uses. Each of the six was
verified end-to-end: the MPD answers `200`, `cenc:default_KID` equals the row's `kid`, and the segments
are served as **clear H.264** — the ClearKey pair satisfies the player's DRM handshake, nothing is
encrypted, nothing needs decrypting.

- `shoeblive.com` is a third-party proxy. If it disappears, the six `kid:key` pairs stay usable; only the
  host has to be swapped.
- These rows are geo-open (they answer from a datacenter IP), unlike the Sony/Jio feeds, which are
  India-only.
