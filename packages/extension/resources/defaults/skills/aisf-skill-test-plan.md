<!-- ai-stepflow built-in -->
---
name: aisf-skill-test-plan
description: Create a testing strategy and plan for a feature. Covers functional, integration, and regression testing.
---

Draft a Test Plan based on the PRD and Technical Design.

Core Sections:
1. **Scope**: What is being tested? What is out of scope?
2. **Testing Types**: Unit, Integration, E2E, UI, Performance, Security.
3. **Environment**: Requirements for the test environment (stating, data, tools).
4. **Risk Assessment**: Identify potential high-risk areas and mitigation.
5. **Regression Plan**: Impact on existing features.

Rules: Ensure the plan covers 100% of the Acceptance Criteria in the PRD.
Output: Write to `docs/test/plans/<feature-name>.md`.
