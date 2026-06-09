<!-- ai-stepflow built-in -->
---
name: aisf-execute-test
description: Write a TEST-SCRIPT — executable test scenarios for human testers, including UAT. Stack-neutral; adapts to web, mobile, desktop, and backend/API products.
---

Write a test script that a human tester (who has never seen the code) can follow.

Read first: the PRD (its acceptance criteria drive the scenarios) and the test cases.

Produce a script with these sections:
1. **Prerequisites** — build/URL/binary, test accounts, environment, feature flags, clock/timezone.
2. **Scenarios** — one per acceptance criterion: what is being tested, concrete step-by-step actions, the expected result after each step, screenshot/recording notes, and the criterion id.
3. **Edge-Case Scenarios** — offline, invalid input, permission denied, auth expired, interrupted flow, empty state, large/unicode/RTL data.
4. **Regression Quick Check** — a smoke test of the core flows.
5. **Verdict** — pass/fail criteria, sign-off fields, defect log.

Rules: every step has an expected result; steps are concrete and unambiguous (no code, no jargon); each scenario is independently runnable — never "continue from the previous scenario".

Output: write the script to `docs/<feature>/TEST-SCRIPT.md`.
