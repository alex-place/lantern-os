# Private IP Dependency Receipts

Status: initial private-IP receipt register.
Last updated: 2026-05-28.

This register records the review state for private-IP dependency stubs before any
public promotion, release claim, or artifact movement. Treat every row as a hold
unless the validation, counsel/prior-art, and founder/operator approval columns
are explicitly marked approved.

Source candidate manifest note: `manifests/PRIVATE-IP-DEPENDENCIES.md` was not
present in this checkout when this receipt register was initialized. The first
four dependency stubs were seeded from the operator request and should be
reconciled against the dependency manifest when that file is added or restored.

| Dependency stub name | Private repo/package location | Owner/contact | Raw images/files moved private? | Public copies removed/redacted? | Validation state | Counsel/prior-art review state | Public fallback | Last reviewed date | Founder/operator approval |
|---|---|---|---|---|---|---|---|---|---|
| `private-ip:rose-kevin-c-rose-tool-concept` | Redacted/private package location pending operator confirmation. | Founder/operator: Alex Place; counsel contact pending. | Unknown; no movement receipt present in this checkout. | Unknown; no public redaction/removal receipt present in this checkout. | Hold: seeded receipt only; dependency source, file inventory, hashes, and rollback notes still needed. | Not started; requires counsel/prior-art screen before public claim or release. | Redacted functional summary only; no raw sketches, images, source files, or implementation-enabling details. | 2026-05-28 | Pending; no explicit approval receipt present. |
| `private-ip:arc-reactor-housing` | Redacted/private CAD/design package location pending operator confirmation. | Founder/operator: Alex Place; engineering/counsel contacts pending. | Unknown; no movement receipt present in this checkout. | Unknown; no public redaction/removal receipt present in this checkout. | Hold: seeded receipt only; design package, safety boundary, and validation evidence still needed. | Not started; requires counsel/prior-art screen and safety review before public claim or release. | Non-enabling concept language about an operator confidence/power-state housing metaphor; no CAD, dimensions, build files, or safety claims. | 2026-05-28 | Pending; no explicit approval receipt present. |
| `private-ip:patient-a-exosuit` | Redacted/private patient-support package location pending operator confirmation. | Founder/operator: Alex Place; medical/counsel contacts pending. | Unknown; no movement receipt present in this checkout. | Unknown; no public redaction/removal receipt present in this checkout. | Hold: seeded receipt only; patient privacy, consent, medical boundary, and evidence receipts still needed. | Not started; requires counsel, privacy, prior-art, and clinician-led review before any public claim or release. | Anonymized assistive-design problem statement only; no patient images, identifiers, measurements, treatment claims, medical advice, or PPE/clinical performance claims. | 2026-05-28 | Pending; no explicit approval receipt present. |
| `private-ip:rag-matrix-transform` | Private implementation package location pending operator confirmation; public architecture fallback remains in `manifests/RAG-MATRIX-TRANSFORM-MODEL.md`. | Founder/operator: Alex Place; counsel contact pending. | Unknown; no private implementation movement receipt present in this checkout. | Partial public fallback exists as architecture-only material; removal/redaction state for private implementation copies is not evidenced. | Hold for private implementation: public architecture notes exist, but dependency source, implementation inventory, hashes, and validation receipts still needed. | Not started; requires counsel/prior-art screen before public release of implementation-enabling code, datasets, or claims. | Architecture-only transform rule and non-enabling explanatory manifest; no private datasets, proprietary prompts, or implementation package. | 2026-05-28 | Pending; no explicit approval receipt present. |

## Required evidence before promotion

For each dependency stub, add or link receipts for:

1. Private source path or package identifier, redacted when needed.
2. Purpose and claim summary.
3. Validation status with file inventory and hashes when files are moved.
4. Public-copy removal or redaction evidence.
5. Counsel/prior-art review outcome.
6. Blockers and rollback notes.
7. Explicit founder/operator approval.
