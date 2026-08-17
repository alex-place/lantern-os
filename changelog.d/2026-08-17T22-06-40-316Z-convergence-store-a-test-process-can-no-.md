### Fixed

- Convergence store: a test process can no longer reach the live convergence store. Centralized the records path in convergence-records.js and auto-redirect it under node --test (NODE_TEST_CONTEXT) / NODE_ENV=test; routed the dream-chat and keystone-runtime emitters through it so all three paths (not just the trader) are covered. Fixes the 13-record leak (#3293, extends #3292).
