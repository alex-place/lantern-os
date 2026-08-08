### Fixed

- trader UI: `realized_today` sums **every** exit row for the day. It previously kept only the last exit per symbol and skipped symbols that were open again — so a symbol closed and re-entered the same day lost its realized P&L entirely. On 2026-08-07 that dropped QQQ (+$218.48) and XLK (−$641.92), reading −$230.98 instead of −$654.42 and showing Day P&L as +$80.55 instead of −$342.89.
