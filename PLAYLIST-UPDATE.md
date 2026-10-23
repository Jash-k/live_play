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
| Sources | 2 raw-GitHub playlists | Those two **plus** the community index at `playlists.dbprojects.workers.dev` (18 pinned providers + auto-discovery of new ones) |
| Source formats | M3U only | M3U **and** JSON channel/event dumps (JioTV arrays, FanCode/SonyLIV events) |
| Structure | One 56-line script | `scripts/lib/` modules (parse, classify, render, sources) with an offline test suite and a validator |
| Duplicates | Deduplicated only by identical URL + props | One row per stream URL (keeping the copy with playback metadata) and a per-brand alternate cap |
| Reporting | `jash-live.stats.json` | Same file, richer: per-source results, discovery decisions, drop reasons, group counts — plus an auto-generated `CHANNEL-SUMMARY.md` |
| CI | Test → curate → publish | Test → curate → validate → publish, with a guard that refuses to publish a thin feed |

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
