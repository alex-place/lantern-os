# Public Report Evidence Boundary

Status: active guidance.

Use this document when preparing public-facing Lantern OS reports, PDFs, packets, founder updates, funding notes, technical runtime notes, patent/IP notes, or support/outreach packets.

## Rule

Public reports may use metaphor, cinematic framing, mythic language, or lore as presentation only. That language must not carry factual weight.

When a public report contains patent, clinical, medical, funding, revenue, wallet, live-runtime, MCP, tunnel, identity, partnership, deployment, user-proof, or cash-proof claims, the claim must be labeled with:

- evidence class;
- confidence;
- boundary state;
- source path or citation;
- next validation gate.

If labels are missing, mark the claim `held` and move it to risks/gates instead of presenting it as public proof.

## Section split

If mythic/lore framing appears near high-stakes claims, split the section into:

```text
Narrative framing
Evidence-backed claims
Held gates / next validation
```

## Claim handling

| Claim type | Public-safe handling |
|---|---|
| Patent/IP | Use `concept`, `private IP intake`, `prior-art review pending`, or `not legal advice` unless a filed patent, publication, or legal source is cited. |
| Clinical/medical/support | Use support-packet, research-lead, or outreach-draft language unless official evidence supports diagnosis, treatment, efficacy, institutional approval, or clinical use. |
| Funding/revenue/cash | Distinguish `planned`, `drafted`, `sent`, `paid`, and `cleared`. Do not treat forecasts or invoices as cash. |
| Runtime/live system | Distinguish `designed`, `local draft`, `validated locally`, `tunnel exposed`, `live`, and `monitored`. |
| MCP/tooling | Verify actual exposed tools/resources before relying on advertised capability. |
| Identity/partnership | Require direct evidence. Do not infer identity, endorsement, or partnership from resemblance, theme, proximity, or intent. |

## Minimum public report gate

Before publishing or exporting a report:

1. Identify all high-stakes claims.
2. Add evidence class and boundary state to each one.
3. Separate narrative framing from evidence-backed claims.
4. Move unsupported claims into held gates.
5. Record remaining validation work in the report.

This complements the Super Jarvis Lantern OS reporting rule that sensitive claims require explicit evidence class and boundary state.
