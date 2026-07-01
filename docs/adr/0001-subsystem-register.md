# Subsystem Register for One-Loop Alignment

**Status:** Proposed

**Context:**
- The current application (trading, Discord bot, radio/lounge, creator tools, ~100 MCP tools, 50+ HTML surfaces) exhibits significant sprawl, violating the 'one loop, four objects; reject sprawl' North Star principle.
- This sprawl has been identified as a major gap (graded D+).

**Problem:** Lack of clear alignment of top-level subsystems with the core operational loop stages (Observe/Remember/Reason/Act/Verify/Converge), leading to complexity and maintenance overhead.

**Decision:**
- We will produce a Subsystem Register as part of this ADR.
- Every top-level subsystem will be mapped to the specific loop stage it primarily improves (Observe, Remember/Reason/Act/Verify/Converge), or explicitly marked for extraction/removal.
- This register will serve as a foundational document for future architectural decisions and refactoring efforts.

**Subsystem Register:**
| Subsystem         | Primary Loop Stage | Notes/Action                               |
|-------------------|--------------------|--------------------------------------------|
| Trading           | Act                | Core operational component                 |
| Discord Bot       | Act/Observe        | Integrates with trading, user interaction  |
| Radio/Lounge      | Converge           | Community engagement, potential for review |
| Creator Tools     | Act/Reason         | Content generation, analysis               |
| MCP Tools (~100)  | Varies             | Requires detailed audit, likely extraction |
| HTML Surfaces (50+)| Varies             | Requires detailed audit, likely extraction |

**Consequences:**
- **Positive:** Increased clarity on subsystem purpose, reduced architectural sprawl, improved alignment with North Star, clearer path for refactoring and deprecation.
- **Negative:** Initial effort required for audit and documentation.

**Acceptance Criteria:**
- Every shipped surface names a loop stage or is scheduled for deletion/extraction.
- This ADR is formally accepted by relevant stakeholders.
