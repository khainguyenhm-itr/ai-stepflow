<!-- ai-stepflow built-in -->
---
name: aisf-test-cases
description: Generate detailed, executable test cases from a PRD or Test Plan.
---

Generate test cases for the feature.

Format:
- **ID**: TC-XXX
- **Title**: Short descriptive title.
- **Preconditions**: State of the system before the test.
- **Steps**: Numbered list of actions.
- **Expected Result**: What the system should do.
- **Acceptance Criterion**: Which AC from the PRD this covers.

Rules: Group by functionality. Include both positive and negative scenarios.
Output: Write to `docs/test/cases/<feature-name>.md`.
