# Archive Commons Source Policy

Use public interfaces and rights-aware metadata only.

## Sources

- Internet Archive metadata API: item card catalog and file metadata.
- Internet Archive advanced search API: search by mediatype, collection,
  license, rights, title, creator, and identifier.
- Wayback CDX API: capture metadata for URLs, not a license to republish
  captured copyrighted pages.
- Creative Commons discovery: find CC-licensed and public-domain works.
- OSS repositories: clone only with operator-approved target paths.

## Media Lanes

| Lane | First Query Target | First Output |
|---|---|---|
| free music | IA audio with CC/public-domain signals | metadata rows |
| free movies | IA moving image with public-domain/CC signals | metadata rows |
| free games | IA software with source/rights review | metadata rows |
| OSS | GitHub/API metadata and clone plan | repo rows |
| Wayback | CDX captures for operator URLs | capture rows |

## Rejection Rules

Reject or mark held when:

- license is absent or contradictory;
- item is a borrowed/controlled lending book;
- commercial media appears uploaded without clear rights;
- full download would be large or bandwidth-heavy;
- source terms forbid redistribution.
