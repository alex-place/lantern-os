# All Repos Inventory

Status: dependency inventory for the top-down Lantern OS control plane.

Generated from the connector inventory captured in `reports/LANTERN-OS-ALL-REPOS-CODE-MASTER-PLAN-2026-05-26.md`.

## Rule

Lantern OS is the project and control plane. Old repositories, legacy code, app code, game code, service code, documents, assets, and vendor-sized forks are dependencies. They are not automatically promoted, merged, vendored, rewritten, or copied into Lantern OS.

Each dependency moves through this path:

```text
registered -> read_only_inspected -> dependency_profiled -> adapter_or_manifested -> promoted_or_held
```

No dependency can skip local status, remote, branch, build/test, secrets/env, artifact, and fallback review.

## Inventory Summary

| Metric | Count |
|---|---:|
| Accessible repositories | 43 |
| Public repositories | 31 |
| Private repositories | 12 |
| Default branch `master` | 36 |
| Default branch `main` | 7 |
| Connector search-indexed | 16 |
| Connector not indexed | 27 |

## Dependency Classes

| Class | Meaning | Default Action |
|---|---|---|
| `core_control` | Lantern OS control-plane repo and local operator surfaces | keep in Lantern OS |
| `execution_dependency` | orchestration, MCP, agents, scripts, queues, runners | reference and validate before use |
| `rag_dependency` | RAG, symbolic, framework, evidence, documents, PDFs, images | index metadata first; copy selected owned assets only |
| `business_service_dependency` | apps, services, money/store/product surfaces | hold on secrets/env until inspected |
| `game_dependency` | game projects, GameMaker, libGDX, assets | preserve source repo; manifest assets, do not bulk copy |
| `library_vendor_dependency` | libraries, API clients, large forks | treat as external/vendor unless fork delta is required |
| `site_content_dependency` | sites, content repos, public pages | metadata-first; rights gate before copying |
| `placeholder_dependency` | empty/nearly-empty control points | held until assigned purpose |
| `retired_reference` | old validation/recovery/backup paths | evidence only; never active runtime |

## Repository Inventory

| # | Repository | Visibility | Branch | Size KB | Indexed | Dependency Class | Fallback State |
|---:|---|---|---|---:|---|---|---|
| 1 | `alex-place/Mr.Nom` | public | master | 680 | no | `game_dependency` | preserve/source-summary only |
| 2 | `alex-place/KeepSafe` | public | master | 9900 | no | `business_service_dependency` | held until runtime/env known |
| 3 | `alex-place/The_Josephus_Problem` | public | master | 212 | no | `library_vendor_dependency` | sample/reference only |
| 4 | `alex-place/OpenTray` | public | master | 180 | no | `business_service_dependency` | desktop utility reference |
| 5 | `alex-place/Returners` | public | master | 146656 | no | `game_dependency` | preserve/source-summary only |
| 6 | `alex-place/Quest` | public | master | 38944 | no | `game_dependency` | preserve/source-summary only |
| 7 | `alex-place/LoL-Chat` | public | master | 4507 | no | `business_service_dependency` | API-currentness review first |
| 8 | `alex-place/jriot` | public | master | 324 | no | `library_vendor_dependency` | external/API client reference |
| 9 | `alex-place/GDungeon` | public | master | 1508 | no | `game_dependency` | preserve/source-summary only |
| 10 | `alex-place/libgdx` | public | master | 835619 | no | `library_vendor_dependency` | vendor-sized; do not absorb |
| 11 | `alex-place/GDXJam` | public | master | 92090 | no | `game_dependency` | preserve/source-summary only |
| 12 | `alex-place/GdxJam2` | public | master | 18156 | no | `game_dependency` | preserve/source-summary only |
| 13 | `alex-place/Orion` | public | master | 1264 | no | `game_dependency` | preserve/source-summary only |
| 14 | `alex-place/corporate_crawler` | public | master | 776 | no | `business_service_dependency` | held for endpoint/rights review |
| 15 | `alex-place/Porkopolis` | public | master | 30504 | no | `game_dependency` | preserve/source-summary only |
| 16 | `alex-place/Cloudbot` | public | master | 2564 | no | `business_service_dependency` | bot token/env review first |
| 17 | `alex-place/clouddataissexy` | public | master | 4133 | no | `business_service_dependency` | app/env review first |
| 18 | `alex-place/riot-api-java` | public | master | 3894 | no | `library_vendor_dependency` | API-currentness review first |
| 19 | `alex-place/Dungeon` | public | master | 781 | no | `game_dependency` | preserve/source-summary only |
| 20 | `alex-place/VisionPark` | public | master | 0 | no | `placeholder_dependency` | held |
| 21 | `alex-place/dnd_homebrew` | public | master | 33 | no | `site_content_dependency` | rights/content review first |
| 22 | `alex-place/alex-place..github.io` | public | master | 2 | no | `placeholder_dependency` | held |
| 23 | `alex-place/alex-place.github.io` | public | master | 44 | no | `site_content_dependency` | public-site reference |
| 24 | `alex-place/moneybags` | public | master | 61228 | yes | `business_service_dependency` | wallet/store inspiration; inspect first |
| 25 | `alex-place/TheGiddyLimit.github.io` | public | master | 1456094 | no | `site_content_dependency` | metadata-first; rights gate |
| 26 | `alex-place/tradiest` | public | master | 2 | no | `placeholder_dependency` | held |
| 27 | `alex-place/badslothserver` | private | master | 10 | yes | `business_service_dependency` | secrets/env held |
| 28 | `alex-place/server-debugclient` | public | master | 6 | yes | `business_service_dependency` | debug-only fallback |
| 29 | `alex-place/slothapi` | public | master | 17 | yes | `business_service_dependency` | API/env review first |
| 30 | `alex-place/BadSloth` | public | master | 300 | yes | `game_dependency` | client source-summary |
| 31 | `alex-place/MysticGarden` | public | master | 16672 | no | `game_dependency` | preserve/source-summary only |
| 32 | `alex-place/intspeedcheck` | private | main | 4 | yes | `business_service_dependency` | utility reference; inspect first |
| 33 | `alex-place/statusmonitor` | private | main | 11 | yes | `business_service_dependency` | monitoring fallback candidate |
| 34 | `alex-place/smartmealplanning` | private | main | 10 | yes | `business_service_dependency` | family/productivity candidate |
| 35 | `alex-place/SmartBid` | private | master | 63 | yes | `business_service_dependency` | SMB cleanup candidate |
| 36 | `alex-place/ChildOfLevistus` | private | master | 183750 | yes | `game_dependency` | GameMaker/game lane candidate, cloud-access enabled for users |
| 37 | `alex-place/gamemaker-room-editor` | private | main | 377 | yes | `execution_dependency` | GameMaker tooling adapter, cloud-access enabled for users |
| 38 | `alex-place/gm-agent-orchestrator` | private | master | 6126 | yes | `execution_dependency` | authoritative agent/MCP source |
| 39 | `alex-place/place_co` | private | main | 143 | yes | `site_content_dependency` | company/public surface candidate |
| 40 | `alex-place/lantern-symbolic-sandbox` | private | master | 16243 | yes | `rag_dependency` | symbolic/RAG/quarantine dependency |
| 41 | `alex-place/lantern-os` | private | master | 5330 | yes | `core_control` | project/control plane |
| 42 | `human-flourishing-frameworks/human-flourishing-frameworks` | private | master | 8721 | yes | `rag_dependency` | COMET LEAP/framework source |
| 43 | `human-flourishing-frameworks/.github` | public | main | 0 | no | `placeholder_dependency` | org profile/config only |

## Local Observed Dependency Paths

| State | Path | Dependency Class | Use |
|---|---|---|---|
| `local_inspected` | `C:\tmp\lantern-os` | `core_control` | clean control plane |
| `local_inspected` | `C:\Users\alexp\Documents\gm-agent-orchestrator` | `execution_dependency` | local MCP/orchestrator source |
| `local_inspected` | `C:\Users\alexp\Documents\lantern-symbolic-sandbox` | `rag_dependency` | symbolic sandbox |
| `local_inspected` | `C:\tmp\human-flourishing-frameworks-scan` | `rag_dependency` | COMET LEAP source |
| `local_inspected` | `C:\tmp\lantern-os\surfaces\windsurf-dev` | `execution_dependency` | Windsurf-inspired developer interface |
| `local_observed` | `C:\tmp\hff-lantern-recovery` | `retired_reference` | recovery evidence only |
| `local_observed` | `C:\tmp\hff-evidence-master-clean` | `retired_reference` | evidence only |
| `local_observed` | `C:\tmp\hff-master-clean` | `retired_reference` | evidence only |
| `local_observed` | `C:\tmp\hff-release-candidate` | `retired_reference` | evidence only |
| `local_observed` | `C:\tmp\hff-seven-validate` | `retired_reference` | retired comparison only |
| `local_observed` | `C:\Users\alexp\Documents\orchestrator-local-backups` | `retired_reference` | backup evidence only |
| `local_observed` | `C:\Users\alexp\Documents\gm-agent-orchestrator-local-backup-20260425-161920` | `retired_reference` | backup evidence only |

## Intake Record Required Per Dependency

```text
repo:
class:
owner:
visibility:
default_branch:
clone_url:
local_path:
local_status:
remote_status:
primary_language:
runtime:
entrypoints:
build_command:
test_command:
validation_receipt:
secrets_or_env:
asset_weight:
rag_state:
dependency_edges:
fallback:
promotion_decision:
next_action:
```

## Promotion Boundary

A dependency may be promoted into Lantern OS only if it has:

1. source path and remote;
2. clean or explicitly recorded dirty state;
3. build/test/run command or reason none exists;
4. secrets/env review;
5. license/rights/asset review;
6. rollback/fallback path;
7. validation receipt;
8. operator approval when required.
