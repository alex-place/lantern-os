### Fixed

- trader-ui: bar-cache prevClose hardened against two live defects — the 16:00-stamped bar is the first post-auction bar, not the close (bars are start-stamped; GLD read 398.71 instead of the true 399.59), and a read racing the collector's file rewrite could serve a weeks-old close as "yesterday" (GLD 372.19, a July price). A prior session older than 7 days is treated as a torn read: null, not memoized, so the next poll re-reads the finished file
