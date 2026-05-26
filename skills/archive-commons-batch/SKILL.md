---
name: archive-commons-batch
description: Batch public-domain, Creative Commons, open-source, and free-culture metadata from Internet Archive, Wayback Machine CDX, OSS repos, free music, movies, software, and games into Lantern OS without piracy or uncontrolled bulk downloads. Use when Codex needs to search Archive.org, Wayback, public media, free games, free movies, free music, or OSS sources for the local RAG dollhouse.
---

# Archive Commons Batch

Use this skill for public-media and web-archive intake.

## Rule

Metadata first. Rights-gated downloads later. Do not ingest copyrighted media
just because it is reachable.

Allowed first-pass states:

- `public_domain`;
- `cc0`;
- `creative_commons`;
- `open_source`;
- `metadata_only`;
- `needs_rights_review`;
- `held`.

## Official Interfaces

- Internet Archive metadata API: `https://archive.org/metadata/{identifier}`
- Internet Archive advanced search: `https://archive.org/advancedsearch.php`
- Wayback CDX API: `https://web.archive.org/cdx/search/cdx`

## Batch Script

Run from `C:\tmp\lantern-os`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-ArchiveCommonsBatch.ps1 -Query "licenseurl:*creativecommons* OR rights:\"Public Domain\"" -MediaType audio -Rows 25
```

Wayback metadata:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-ArchiveCommonsBatch.ps1 -WaybackUrl "example.com" -Rows 25
```

## Output

Default output path:

```text
data/archive-commons/latest-results.json
```

The output is intentionally metadata-first and RAG-ready. Full media downloads
must be a later explicit step.

## Safety

- Prefer public-domain and Creative Commons collections.
- Preserve license, rights, identifier, collection, title, creator, date, and
  source URL.
- Avoid controlled digital lending / borrowed books.
- Avoid copyrighted commercial music, movies, games, and software unless the
  metadata provides clear redistribution rights.
- Rate-limit batches and keep row counts small until the operator approves
  storage and bandwidth use.
