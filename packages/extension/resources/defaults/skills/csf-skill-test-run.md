---
name: csf-skill-test-run
description: Execute tests and report results. Covers automated and manual verification.
tags: [testing, qa]
---
<!-- claudesteps built-in -->

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

## Parallel fan-out
Independent work runs concurrently: dispatch one subagent per slice **in a single message**, then draw the conclusion yourself from their reports.

**Slice this by**: Each independent test suite or environment (never two slices writing the same test data).

- Independent slices only. Anything that depends on another slice's result stays sequential.
- Subagents investigate and report (findings + `file:line`); **you** do every write, so each Mandatory Output File keeps exactly one writer.
- Give each subagent its own explicit scope and ask for a compact report, not a file dump.
- Under a `sandboxed` flow subagents inherit the deny list (no Bash/WebFetch/WebSearch) — keep them read-only.
- One slice, or work you finish in two or three reads? Do it yourself — dispatching costs more than it saves.
