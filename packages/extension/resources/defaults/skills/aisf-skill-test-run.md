---
name: aisf-skill-test-run
description: Execute tests and report results. Covers automated and manual verification.
---
<!-- ai-stepflow built-in -->

Execute test cases and record results.

## Steps
1. **Setup** — configure environment per the Test Plan (Mandatory Input Files). If no Test Plan is available, state the environment and assumptions used before proceeding.
2. **Execute** — run automated tests or perform manual steps per each test case. Reference test case IDs (TC-NNN).
3. **Record results** — for every test case:
   ```
   TC-NNN | Pass / Fail / Blocked | <actual result if differs from expected>
   ```
4. **Log defects** — for each Fail, record:
   ```
   BUG-NNN | TC-NNN | Severity: Critical/Major/Minor
   Description: <what happened>
   Steps to reproduce: <numbered>
   Environment: <OS, browser/runtime version, feature flags>
   Logs/Screenshots: <attached or inline>
   ```
5. **Handle flaky failures** — if a test fails intermittently, mark as `Flaky` (not `Fail`), record the failure rate observed, and log it as a separate defect for investigation.
6. **Report summary**:
   ```
   Total: N  |  Pass: N  |  Fail: N  |  Blocked: N  |  Flaky: N
   Coverage: N% of PRD ACs verified
   Open Critical defects: N
   Release recommendation: Go / No-Go / Conditional
   ```

Write to the path specified in Mandatory Output Files.
