<!-- ai-stepflow built-in -->
---
name: aisf-skill-test-run
description: Execute tests and report results. Covers automated and manual verification.
---

Execute the test cases and record the results.

Process:
1. **Setup**: Prepare the environment as per the Test Plan.
2. **Execution**: Run automated tests or perform manual steps.
3. **Observation**: Record actual vs expected behavior.
4. **Reporting**: Pass/Fail status for each case.
5. **Defect Logging**: Create detailed bug reports for failures.

Rules: Be specific about the failure (reproduction steps, logs, environment).
Output: Write to `docs/test/reports/<run-id>.md`.
