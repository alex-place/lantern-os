# ADR 001: Registering Top-Level Subsystems Against the One-Loop Gate

## Status
Proposed

## Context
Our architectural North Star principle is "one loop, four objects; reject sprawl." Despite this guiding principle, we currently face significant application sprawl, leading to increased complexity, duplicated effort, and difficulty in maintaining a cohesive system. This problem has been internally graded as a D+. Many top-level subsystems have emerged organically without explicit alignment or integration into the core "one loop" operational model. This lack of clear definition and integration makes it challenging to understand the overall system architecture, identify redundancies, and ensure that all components contribute effectively to the system's primary objectives.

## Decision
We will establish a formal register for all top-level subsystems, explicitly mapping each subsystem against the stages of the "one loop" (Observe, Remember, Reason, Act, Verify, Converge) or marking it for extraction/removal. This register will serve as a foundational document for architectural governance, ensuring that new subsystems are intentionally designed and existing ones are evaluated for their strategic fit and operational alignment.

The initial register will include the following known top-level subsystems:

| Subsystem          | Proposed Loop Stage / Action | Notes                                                              |
|--------------------|------------------------------|--------------------------------------------------------------------|
| Trading            | Act / Observe                | Core operational component, likely interacts with multiple stages. |
| Discord Bot        | Observe / Act                | Handles external interactions, notifications, and commands.        |
| Radio/Lounge       | Observe / Act                | Manages media playback and community engagement.                   |
| Creator Tools      | Act / Converge               | Tools for content generation and system configuration.             |
| MCP Tools          | Act / Verify                 | Management, Control, and Planning tools.                           |
| HTML Surfaces      | Observe / Act                | User interfaces and data visualization.                            |
| (New Subsystem 1)  | [Placeholder]                | For future additions.                                              |
| (New Subsystem 2)  | [Placeholder]                | For future additions.                                              |

This register will be a living document, reviewed and updated as the architecture evolves.

## Consequences
### Positive
- **Reduced Sprawl:** Provides a clear mechanism to identify and address redundant or misaligned subsystems.
- **Improved Cohesion:** Encourages design and development efforts to align with the "one loop" model.
- **Enhanced Clarity:** Offers a single source of truth for understanding the top-level system architecture.
- **Better Governance:** Establishes a framework for evaluating new subsystem proposals and managing existing ones.

### Negative
- **Initial Overhead:** Requires an upfront effort to define and categorize existing subsystems.
- **Maintenance Burden:** The register needs to be actively maintained to remain relevant.
- **Potential for Resistance:** Some teams may resist changes to their subsystems if they are marked for significant re-alignment or removal.
