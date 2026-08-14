### Changed

- trader-ui: the day panel now reads straight down — Realized + Unrealized = Day P&L. Realized is TODAY's realized (starts at $0 every session) instead of whole-lot cash, which is what made 2026-08-13 show "+$2,144.95 and +$5,508.18" summing to "+$2,533.54". The banked-cash figure moved to the tooltip, and the positions table gained a Day P&L column beside Unrealized so a carried position shows both its today move and its since-entry life
