# ADR 0001: Subsystem Register and One-Loop Gate Audit

## Status
Proposed

## Context
Our current system suffers from significant application sprawl, leading to a fragmented architecture that is difficult to understand, maintain, and evolve. This sprawl is a direct violation of our "one loop, four objects" North Star principle, which advocates for a cohesive, single-loop architecture with clear responsibilities. The recent architectural audit assigned a D+ grade, highlighting the urgent need to address this issue. Many disparate tools, services, and user interfaces have emerged organically, often duplicating functionality or operating in isolation, without a clear mapping to the core operational loop stages.

## Decision
We will create a comprehensive subsystem register. This register will serve as a definitive inventory of all identified top-level subsystems within our ecosystem. For each subsystem, we will explicitly map it to one of the six fundamental loop stages: Observe, Remember, Reason, Act, Verify, or Converge. Subsystems that cannot be clearly mapped to a loop stage, or are deemed redundant or outside the scope of the core loop, will be explicitly marked for extraction or removal.

Examples of top-level subsystems to be registered include, but are not limited to:
- Trading systems
- Discord bot integrations
- Radio/Lounge features
- Creator tools
- Approximately 100 MCP (Mission Control Platform) tools
- Over 50 distinct HTML surfaces

The goal is to ensure that every shipped surface or significant subsystem either clearly names a loop stage it primarily serves or is scheduled for deletion/extraction.

## Consequences
This decision will provide a clear, structured approach to addressing application sprawl. By explicitly mapping every top-level subsystem to a specific loop stage, we will:
1.  **Reduce Sprawl:** Force a critical evaluation of every component, identifying redundancies and opportunities for consolidation or removal.
2.  **Align with North Star:** Re-establish alignment with the "one loop, four objects" principle, fostering a more coherent and understandable architecture.
3.  **Improve Maintainability:** Provide a clear architectural blueprint, making it easier for developers to understand where new features fit and how existing components interact.
4.  **Guide Future Development:** Offer a robust framework for future development and refactoring efforts, ensuring that new components are designed with the overall loop in mind.
5.  **Meet Acceptance Criteria:** Explicitly ensure that "every shipped surface names a loop stage, or is scheduled for deletion/extraction," thereby meeting a critical acceptance criterion for architectural health.
