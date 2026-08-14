### Fixed

- trader-ui: the Orders tab and cancel button now follow the admin operator-view fallback that account/positions/placement already had. Live 2026-08-14: four flatten sells — one a duplicate — rested at IBKR while the Orders tab said "None", so the one screen that could cancel the duplicate had nothing to click. Operator rows are flagged `operator_account`; a cancel that acts on the operator book reports `broker:'ibkr-operator'`; non-admins can reach neither
