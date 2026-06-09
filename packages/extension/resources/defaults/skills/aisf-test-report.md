<!-- ai-stepflow built-in -->
---
name: aisf-test-report
description: Summarize an executed test run into a TEST-REPORT — pass/fail per case, defects found, coverage vs the test plan, and a go / no-go recommendation. Pairs with the execute-test skill.
---

Summarize the executed test run for the feature in the input.

Read first: the test script and test cases, the test plan (for coverage targets), and the PRD (for the acceptance criteria to verify).

Steps:
1. For every executed case, record pass / fail / blocked with evidence (logs, screenshots, repro steps).
2. Log each defect found: severity, the affected acceptance criterion, repro steps.
3. Summarize coverage against the test plan — which planned cases ran, which were skipped and why.
4. Give a clear go / no-go recommendation.

Report sections:
- **Summary** — total cases, passed, failed, blocked, overall verdict.
- **Per-case results** — table of id, title, result, notes.
- **Defects** — id, severity, affected criterion, status.
- **Coverage** — planned vs executed, gaps.
- **Recommendation** — ship or hold, with the blocking items listed.

Rules: report what actually happened — evidence required. Tie every failure back to its acceptance criterion. Be factual and skimmable.

Output: write the report to `docs/<feature>/TEST-REPORT.md`.
