# Archive Commons Rights Review Gate

Generated: 2026-05-26.

Status: active gate before media ingestion.

## Decision

Archive/Wayback/media remains metadata-first, but it is no longer a vague
blocker. Every row must land in one of these decisions:

| Decision | Meaning | Download |
|---|---|---|
| `allow_metadata_only` | safe to index metadata only | no |
| `candidate_download_after_operator_review` | clear open-rights signal exists | not automatic |
| `hold_no_rights_signal` | license/rights absent or unclear | no |
| `reject_likely_restricted` | controlled lending, commercial media, or conflicting rights | no |

## Required Evidence

An item can become a download candidate only if at least one field shows:

- public domain;
- CC0;
- Creative Commons license;
- open-source license;
- explicit rights statement allowing redistribution.

## Wayback Rule

Wayback captures are citation/evidence metadata. They are not download or
republish permission.

## Storage Rule

Before any full media download, record:

- expected file count;
- expected byte size;
- license/right source;
- storage target;
- rollback/delete plan.
