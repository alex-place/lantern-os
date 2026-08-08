### Fixed

- Security: force exceljs's transitive brace-expansion (1.1.18 / 2.1.4) and uuid (11.1.1) to patched versions via npm overrides, clearing 7 Dependabot alerts (#244, #248-254; GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895, GHSA-w5hq-g745-h8pq). exceljs stays at 4.4.0; xlsx write+read verified.
