### Added
- New **Work page** (`/work.html`, linked in the nav): the "Pull Work" issue
  picker (open GitHub issues, search/priority filter, research + coding-agent
  handoffs, fleet delegation) and the "Recently Landed" merged-PR log now live
  here on their own page.

### Changed
- **Orchestration dashboard** is now focused on the autonomous loop: the manual
  issue-picker and landed log moved to `/work.html` (a "Pull Work" panel links
  across). The GPU Training panel gained a self-updating live tick — when jobs
  are running it auto-polls and refreshes (every 12s, skipped on hidden tabs) —
  plus per-provider status badges that are never blank (running / queued / error
  / done / quota-used / idle / not-tested-yet) and an "updated HH:MM:SS" stamp.
