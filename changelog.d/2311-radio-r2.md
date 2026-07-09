chore(media): move radio mp3s to R2 and untrack from git (#2311)

Uploaded the on-disk radio set (35 mp3s) to the keystone-media R2 bucket under
radio/ (served from https://media.lantern-os.net/radio/) via wrangler + the
machine CLOUDFLARE_API_TOKEN, immutable 1-year cache. Repointed the matching
src refs in fallout-radio.html (25) and radio/stations.json (35) to the CDN,
git rm --cached the 25 tracked mp3s (66MB), added *.mp3 to .gitignore. Verified
the CDN serves audio/mpeg. stations.json stays tracked (text manifest); its
~248 other tracks reference mp3s absent from both repo and CDN — a pre-existing
dangling-reference bug, out of scope here. Improves Remember.
