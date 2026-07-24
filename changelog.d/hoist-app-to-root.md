### Repo restructure: the app IS the repo now — apps/lantern-garage hoisted to root

Operator directive 2026-07-24. `server.js`, `lib/`, `routes/`, `public/`, `test/`, desktop and
service-automation now live at the repo root (791 git renames — history preserved). The two
package.jsons merged into one (13 app deps + 64 scripts, zero version conflicts); every
`__dirname` escape in 304 files mechanically re-rooted (2 levels stripped — verified by a
relative-require resolver lint: 0 broken requires, the only survivors being comment examples and
one pre-existing guarded optional); all 7 CI workflows, dependabot, deploy pages-build, 67
scripts, and 87 docs re-pathed. Known pre-existing break left as-is: lib/scoring-engine-v2.js
duplicate declaration (broken before the move). Deploy configs (Railway root, GCE path, stable
host launchers) MUST be re-verified by the operator before this merges — PR is a draft for
exactly that reason.
