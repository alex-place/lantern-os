### Added

- Modal wired as a first-class GPU-training provider alongside Lightning (scripts/modal_dispatch.py + training-dispatcher.js): dispatch-all now runs the same seeded Ouro job on two independent clouds concurrently for redundancy. Default provider registry un-bricks the orchestration panel on fresh clones (runtime PCSF is gitignored) and appends modal to hosts that predate it without clobbering live state. Adds scripts/reconcile_dual_provider.py + dual-provider runbook section.
