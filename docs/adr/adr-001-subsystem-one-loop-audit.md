# ADR 001: Subsystem One-Loop Audit

## Status
Proposed

## Context
The current application architecture (trading, Discord bot, radio/lounge, creator tools, ~100 MCP tools, 50+ HTML surfaces) violates the North Star principle: 'one loop, four objects; reject sprawl'. This sprawl is a significant architectural debt, impacting maintainability and conceptual integrity.

## Decision
To address the sprawl and align with the 'one loop' North Star, we will produce a subsystem register. This register will map every top-level subsystem to the specific loop stage it primarily improves (Observe, Remember, Reason, Act, Verify, Converge), or explicitly mark it for extraction or removal. This ADR will serve as the formal proposal for this audit and its outcomes.

### Subsystem Register (To be populated)
| Subsystem | Primary Loop Stage | Rationale / Action |
|---|---|---|
| Trading | Act / Observe | Core business logic, needs clear stage definition. |
| Discord Bot | Act / Observe | Interface for user interaction, data collection. |
| Radio/Lounge | Act / Converge | User engagement, potential for extraction. |
| Creator Tools | Act / Reason | Tools for content generation, decision support. |
| MCP Tools (~100) | Varies | Many small tools, likely need consolidation or clear stage mapping. |
| HTML Surfaces (50+) | Varies | User interfaces, each needs to serve a clear purpose within a loop stage. |
| *[Add other top-level subsystems here]* | | |

## Consequences
*   **Positive:** Improved architectural clarity, reduced sprawl, better alignment with North Star, easier onboarding for new developers, clearer product strategy.
*   **Negative:** Initial time investment for audit and documentation, potential for difficult decisions regarding subsystem extraction/removal.

## Compliance
This decision directly addresses the 'Converge (reject sprawl)' loop stage and aims to bring the system into compliance with the 'one loop, four objects' North Star principle. Acceptance of this ADR will signify commitment to this architectural cleanup.
