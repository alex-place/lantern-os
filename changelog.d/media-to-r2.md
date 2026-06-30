### Changed
- **All binary media moved off Git-LFS → Cloudflare R2.** The repo's LFS budget was
  exhausted, aborting clones/checkouts with a smudge error (the Colab notebook, the stable
  auto-deploy, even local branch switches). All raster images + PDFs now leave git entirely
  and serve from R2 (the existing `media.lantern-os.net` setup, extended). `.gitattributes`
  drops the LFS filters; `.gitignore` ignores `*.png/jpg/jpeg/gif/webp/pdf/zip/mp4` (SVGs stay
  tracked); the 76 LFS files were `git rm --cached` (no history rewrite — LFS only smudges
  checked-out files). `scripts/sync-media-r2.sh` now uploads the `data/images`, `images`,
  `reports`, `dollhouse`, and `caadi-images` trees too; three-doors web refs use an R2 base.
  See `docs/MEDIA-HOSTING-R2.md` — **run the R2 upload before merging** or the live site 404s.
