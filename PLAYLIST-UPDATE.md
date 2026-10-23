# Playlist update notes (v2)

The feed is no longer pinned to six channels. It is now a full catalogue of Tamil channels,
Tamil/English sports feeds and Bigg Boss Tamil, refreshed every 2 hours.

Main feed:

```
https://raw.githubusercontent.com/Jash-k/live_play/main/jash-live.m3u
```

## What changed in v2

| Area | Before | Now |
|---|---|---|
| Scope | Bigg Boss Tamil + Star/Sony/FanCode sports only | All Tamil channels (10 categories) + Bigg Boss Tamil + Tamil/English sports |
| Sources | 2 raw-GitHub playlists | Those two **plus** the community index at `playlists.dbprojects.workers.dev` (18 pinned providers + auto-discovery) **plus** a direct JioTV proxy feed, `hjh-545.pages.dev` |
| Source formats | M3U only | M3U **and** JSON channel/event dumps (JioTV arrays, FanCode/SonyLIV events) |
| Structure | One 56-line script | `scripts/lib/` modules (parse, classify, render, sources) with an offline test suite and a validator |
| Duplicates | Deduplicated only by identical URL + props | One row per stream URL (keeping the copy with playback metadata) and a per-brand alternate cap |
| Reporting | `jash-live.stats.json` | Same file, richer: per-source results, discovery decisions, drop reasons, group counts — plus an auto-generated `CHANNEL-SUMMARY.md` |
| CI | Test → curate → publish | Test → curate → validate → publish, with a guard that refuses to publish a thin feed |

## Source added in this revision

`https://hjh-545.pages.dev/` — a 1,193-entry JioTV playlist whose stream URLs
(`/stream?id=<slug>`) are minted with a fresh token per play, so unlike the static JioTV dumps it does
not carry pre-expired tokens. It contributes ~90 Tamil channels and ~20 sports feeds, including a few
brands no other source had. Configured as `index.staticSources[0]` in
`scripts/curate-live.config.json`; delete that entry to drop it again.

## Stream fingerprints in channel names

Channels with 2-3 alternate streams used to appear as identical names. Each name now ends with
`[protocol · DRM · source]` — e.g. `Star Vijay HD [DASH · ClearKey · JioTV+ 32]` — and entries carry
`base-name`, `stream-type`, `stream-drm` and `stream-source` attributes for grouping/badging in the
app. Set `output.nameTags.enabled: false` in `scripts/curate-live.config.json` for plain names.

## After you push

1. Actions → **Refresh Tamil, sports and Bigg Boss playlist** → *Run workflow* for an immediate
   refresh (the cron only fires every 2 hours).
2. In your player/Live Service, resync the source URL above. Channel names, `tvg-id`, logos and
   logos are kept from upstream; groups are now `Bigg Boss Tamil 24/7`, `Tamil - <Category>` and
   `Sports - <Brand> - <Language>`.
3. If you previously mapped the old narrow feed, re-map the new groups to your catalogues. The old
   `star-sports.m3u` / `build-live-playlist.mjs` files (if still present in your working copy) are
   unused — this workflow does not call them.
4. Optionally subscribe `jash-review.m3u` too — it holds sports feeds whose language upstream never
   states. They are deliberately kept out of the main feed.

## Local run

```bash
npm run check   # tests + refresh + validation
```

Node 20 or newer, no dependencies.
