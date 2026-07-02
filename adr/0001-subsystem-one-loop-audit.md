---
title: 0001-Subsystem One-Loop Audit
status: Proposed
date: 2023-10-27
---

# 0001-Subsystem One-Loop Audit

## Status
Proposed

## Context
Over time, our codebase has accumulated a number of top-level subsystems. While each may have served a purpose at its inception, the current state lacks a clear, consistent architectural vision for these components. This sprawl leads to:
- Difficulty in understanding the system's overall flow and responsibilities.
- Ambiguity regarding ownership and maintenance.
- Potential for redundant functionality or "dead code."
- Challenges in onboarding new team members.
- Increased cognitive load for developers.

Many of these subsystems operate without a clear alignment to the core "one loop" principle that guides our system's overall operation. The "one loop" defines a clear sequence of stages: Observe, Remember, Reason, Act, Verify, Converge. Subsystems should ideally align with one or more of these stages, or be clearly identified as supporting infrastructure.

## Decision
We will conduct an audit of all identified top-level subsystems against the "one loop" principle. For each subsystem, we will:
1.  **Identify its primary purpose and scope.**
2.  **Determine its alignment with the "one loop" stages:**
    *   **Observe:** Gathers data/events from external sources.
    *   **Remember:** Stores and retrieves data, manages state.
    *   **Reason:** Processes data, makes decisions, applies business logic.
    *   **Act:** Executes commands, triggers external actions.
    *   **Verify:** Checks outcomes, ensures correctness, provides feedback.
    *   **Converge:** Synchronizes state, resolves conflicts, brings system to desired state.
3.  **If it doesn't align with a specific stage, categorize it as:**
    *   **Infrastructure/Utility:** Essential supporting component (e.g., logging, metrics, configuration).
    *   **Candidate for Extraction/Removal:** Functionality that is no longer needed, can be absorbed elsewhere, or should be a separate service.
4.  **Populate the "Subsystem Audit Register" below.**

The goal is to ensure every top-level subsystem has a clear, justifiable role within the system's architecture, ideally aligning with a "one loop" stage, or is explicitly marked for refactoring/removal.

## Consequences
*   **Positive:**
    *   Clearer architectural understanding and documentation.
    *   Reduced cognitive load for developers.
    *   Identification and potential removal of redundant or unused code.
    *   Improved maintainability and onboarding.
    *   Stronger adherence to the "one loop" architectural principle.
*   **Negative:**
    *   Requires initial time investment for the audit.
    *   May lead to refactoring efforts for misaligned subsystems.

## Subsystem Audit Register

| Subsystem Name | Current Description | Primary One-Loop Stage(s) | Justification/Notes | Proposed Action (Keep/Refactor/Remove/Extract) |
|---|---|---|---|---|
| `[ExampleSubsystemA]` | `[Manages user authentication]` | `Reason, Act` | `Authenticates users, issues tokens.` | `Keep` |
| `[ExampleSubsystemB]` | `[Legacy reporting module]` | `Remember, Reason` | `Generates daily reports, but largely unused.` | `Refactor/Remove` |
| `[ExampleSubsystemC]` | `[Handles external API calls]` | `Observe, Act` | `Integrates with payment gateway.` | `Keep` |
| `[Subsystem Name]` | `[Description]` | `[Observe/Remember/Reason/Act/Verify/Converge/Infrastructure/N/A]` | `[Detailed justification and observations]` | `[Keep/Refactor/Remove/Extract]` |
