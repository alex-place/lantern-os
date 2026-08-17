### Changed

- trader: the Book tab is gone — the overnight capital allocator is no longer armed, so the panel showed a live-looking sleeve budget that nothing acted on. The allocator and /api/trading/allocator are untouched; only the read-only mirror was removed, so re-arming means re-adding a panel rather than rebuilding a system (#3330)
