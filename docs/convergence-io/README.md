# Convergence IO — the typed primitive stack

`src/convergence_io/` is Keystone's **typed governance + routing layer**: a set of small,
independently-testable primitives that operationalize the project's ten governance
principles (P1–P10) and the external-predicate rule (M1). Each primitive is a *format*
or a *gate* with a narrow contract; together they're meant to route every action through a
constraint-satisfying execution graph with provenance.

This folder documents each primitive from its **source contract** — the External Reality
Rule applies, so status is stated honestly per file.

## The stack at a glance

| Primitive | Full name | Principle | Role | Doc |
|---|---|---|---|---|
| **DCF** | Data Classification Format | P1 (Data Classification) | every datum carries a class label; labels propagate | [DCF.md](DCF.md) |
| **NAP** | Negative Authority Profiles | P2 (Authority / Consent) — *denial* form | what agents are **explicitly denied**; hard denials win | [NAP.md](NAP.md) |
| **AAPF** | Agent Action Provenance Format | P3 (Provenance / Audit) | every action → a reproducible `ActionRecord` ledger | [AAPF.md](AAPF.md) |
| **PCSF** | Provider Capacity State Format | P4 (Capability Constraints) | provider availability + fallback chain + circuit breakers | [PCSF.md](PCSF.md) |
| **CCF** | Capability Claim Format | P4 (Capability Constraints) | an agent must *prove* a claimed capability at action time | [CCF.md](CCF.md) |
| **CEG** | Convergence Execution Graph | — (the substrate) | `G=(V,E,D,τ,S,H)` typed graph all the above plug into | [CEG.md](CEG.md) |
| **D** | Time Dilation Field | — (CEG's `D`) | per-node scalar that slows hard regions / speeds easy ones | [DILATION.md](DILATION.md) |

## How they compose

The intended pipeline routes a request through the graph, gating at each step:

```
   request ─► CEG (build typed graph G=(V,E,D,τ,S,H))
              │
              ├─ DCF   classify every datum (P1)            ── feeds ─► CCF
              ├─ NAP   deny what's forbidden (P2)            ── hard floor, overrides capability
              ├─ CCF   prove required capability (P4)        ── gated by DCF, clamped by NAP
              ├─ PCSF  pick a routable provider (P4)         ── fallback chain + circuit breakers
              ├─ D     dilate per-node latency/cost          ── slow uncertain nodes, speed confident ones
              └─ AAPF  record the action + provenance (P3)
```

The load-bearing ordering rule: **a NAP denial cannot be overridden by a capability claim** —
authority denials are a hard floor under capability. DCF gates CCF (you can't act on data you
haven't classified). PCSF supplies the *where* (which provider), CCF the *whether* (is the
capability proven), NAP the *must-not*, AAPF the *what-happened*.

## Status (honest)

- **Implemented + tested.** Every primitive has a dataclass/gate contract and unit tests
  ([`tests/test_pcsf_ccf.py`](../../tests/test_pcsf_ccf.py), [`test_ceg*.py`](../../tests/),
  [`test_dilation.py`](../../tests/test_dilation.py), [`test_convergence_io.py`](../../tests/test_convergence_io.py)).
- **The production chat path is JS, the primitives are Python.** `lib/stream-chat.js` cannot
  import these directly; it consumes a parallel JS adapter
  ([`lib/grounding-policy.js`](../../apps/lantern-garage/lib/grounding-policy.js),
  [`lib/convergence-adapter.js`](../../apps/lantern-garage/lib/convergence-adapter.js)) for the
  parts it uses (notably the dilation→grounding policy). **Not every primitive is on the hot
  path** — treat these docs as the design + tested contract, and check the adapters for what's
  actually live. See [CODEMAP.md](../CODEMAP.md) for the wiring map.

## Source
- Code: [`src/convergence_io/`](../../src/convergence_io/)
- Math backbone: [SIGMA0-COLLAPSE-CERTIFICATE.md](../SIGMA0-COLLAPSE-CERTIFICATE.md) · [convergence-core-mapping.md](../convergence-core-mapping.md)
