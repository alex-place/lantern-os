# BetterSafe

Local-first household safety and coordination app (`bettersafe.py`,
`bettersafe_db.py`, `modules/`). Everything runs on-device: SQLite (SQLCipher
AES-256 at rest), no cloud sync, no external network dependencies.

This README consolidates the former design docs (`bettersafe-feature-schema.md`,
`bettersafe-local-first-architecture.md`, `social-services-registry-schema.md`
— full text in git history).

## Architecture

- **Stack:** Python + CustomTkinter UI, SQLite + SQLCipher, APScheduler for
  schedules, scipy for signal processing. Zero external/cloud dependencies.
- **Modules** (`modules/`): appliance scheduler, fridge manager, household
  tasks, meal coordinator, safety monitor, social services.
- Integrates as a tab surface in Lantern; data never leaves the device.

## Data model

Nine local tables: `home_sensors`, `safety_events`, `meal_plans`,
`fridge_inventory`, `appliance_status`, `appointments`,
`social_services_registry`, `household_tasks`, `system_logs` — fed by six
processing pipelines (sensor ingest, event detection, meal/fridge sync,
appliance schedules, appointment reminders, service matching).

## Social services registry

Offline registry of public social services for Waynesville (Wayne County) and
Spring Valley (Greene County), Ohio — nine service categories, one JSON entry
per service. Matching is local: `find_eligible_services` scores household needs
against entries and returns matches with `match_score >= 2`. Public information
only; no client data is stored in the registry.

## Security / threat model

- All data at rest encrypted (SQLCipher AES-256).
- No telemetry, no remote endpoints; public-info-only registry.
- Threats considered: device theft (mitigated by encryption), data
  exfiltration (no network paths), stale registry data (manual refresh).
