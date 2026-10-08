# JaSH combined playlist update

Upload the contents of this ZIP into Jash-k/live_play at the repo root.
Overwrite `.github/workflows/jash-live.yml` and `jash-live.m3u` when prompted.
The new workflow replaces the old pinned-six-channel workflow. The old
build-live-playlist.mjs/config and star-sports.m3u can remain, but are no longer
used by this workflow. Do not run the old builder to overwrite the new output.

Actions → Refresh Tamil Bigg Boss and sports → Run workflow. Scheduled refresh
is every2 hours (GitHub may delay scheduled runs). Enable Actions and permit
workflow read/write contents if required. Run Node20 locally:
`node scripts/curate-live.mjs`

Main app source:
https://raw.githubusercontent.com/Jash-k/live_play/main/jash-live.m3u

`jash-review.m3u` is deliberately NOT part of the main feed: missing/conflicting
language evidence remains separate, as requested. `jash-review.json` contains
safe channel names and source locations for review without stream secrets.
Do not import the review playlist into the main catalogue until checked.

Initial results are recorded in jash-live.stats.json. Entries are stream options,
not a count of unique channel brands. Separate quality/source options are kept;
identical stream URL + properties + language entries are deduplicated.

Main: Tamil Bigg Boss24/7, and explicitly Tamil/English-labelled Star, Sony,
FanCode feeds. Willow and Cricbuzz were found but had no explicit language
labels in the sampled sources, so are in Review, NOT relabeled English by guess.
Sony Ten3 Hindi and contradictory Ten4 Hindi-tagged feeds are excluded; an
explicit Tamil Ten4 option is retained. Star3/Khel without approved language
are Review. All other regional languages and nonrequested brands are excluded.
FanCode live event feeds can come and go with the event schedule.

The curator uses BOTH Sportlink-wtf and maybetv/Jo. It preserves upstream stream
URLs and supplied playback properties; it never obtains/changes keys, converts
DRM, authenticates, or claims content rights. Community metadata is not proof
of real audio language. Manifest/segment playback was NOT tested for this
curation. Browser/DRM/region/source availability limits remain.

Only HTTPS entries are included; obvious rawTS/FLV and expired exp/expires
entries are dropped. A feed may still require a compatible browser, legitimate
access, licence settings, or the existing app relay. This is not a guarantee
of free access or all-device playback. The current Bigg Boss feed is sourced
from the Tamil-labelled24/7 entry; season/live availability is not independently
verified. Sources unavailable during refresh are reported; if either repository
has no successful sources or main is empty, existing output is preserved.
Missing families are reported, not fabricated.

After upload, resync this combined source in Live Service and manually map
its channels to your chosen catalogs. Remove/disable the old separate custom
sports source if you no longer want its unfiltered rows; leave Jio untouched.
