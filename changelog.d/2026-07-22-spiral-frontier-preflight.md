### Fixed

- spiral(#2835): **honest-labeling preflight on the Phase-0 runner** — requesting a cloud escalate tier (`SPIRAL_FRONTIER_PROVIDER=openai|gemini|…`) on a box where that provider's leg isn't configured now refuses to run with a clear error instead of silently answering the escalate leg from the first reachable (local) model while labeling every corpus row `frontier:<provider>`. Without this, the "frontier-grade distillTarget" corpus the run exists to seed would be local-model output wearing a frontier label — poisoned VTD fuel that no downstream check could catch.
