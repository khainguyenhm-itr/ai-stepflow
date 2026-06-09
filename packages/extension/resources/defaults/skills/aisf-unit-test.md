<!-- ai-stepflow built-in -->
---
name: aisf-unit-test
description: Write and run unit tests for the implemented feature — cover the acceptance criteria and the test plan's unit-test cases. Stack-neutral; adapts to the project's test framework. Pairs with the implement skill.
---

Write and run unit tests for the feature in the input.

Read first: the test plan (its `UT*` cases), the PRD acceptance criteria, the feature branch code, and existing tests for the framework's conventions.

Steps:
1. Write the tests before the production code exists; confirm they fail (red).
2. Cover the happy path and the error paths from the acceptance criteria.
3. Name each test after its plan id (e.g. `UT03`) so a failure points back to the plan.
4. Keep them deterministic: fixed seeds, injected clock, no live network.
5. After the implementation is green, re-run the whole-project coverage and record the command and total % in `IMPLEMENT-SUMMARY.md`.

Rules: test behavior, not implementation. Use arrange/act/assert. One logical assertion per test. Never weaken an assertion just to silence a flaky test — fix the source of nondeterminism instead. Don't test states the type system already rules out.
