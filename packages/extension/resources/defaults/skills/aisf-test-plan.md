<!-- ai-stepflow built-in -->
---
name: aisf-test-plan
description: Write a test plan — unit, contract, integration, E2E, non-functional (performance, accessibility, security), and regression — adapted to the stack in play.
---

Write a test plan for the feature in the input.

Read first: the PRD (its acceptance criteria are your test inputs), the tech design (for file impact), and existing tests for style.

Produce a plan with these sections:
1. **Test Scope** — map each acceptance criterion to the test types that cover it; call out what is out of scope.
2. **Environment / Compatibility Matrix** — the smallest set of OS/browser/device/locale dimensions that covers the risk.
3. **Unit Tests** (UT) — pure logic, deterministic, boundary conditions.
4. **Contract Tests** (CT) — request/response shapes at boundaries.
5. **Integration Tests** (IT) — multi-module with real dependencies.
6. **UI / Component Tests** (UI) — rendering, interaction, accessibility.
7. **E2E Tests** (E2E) — full user flows.
8. **Failure-Mode Tests** — network loss (NET), lifecycle (LC), permission (PM), upgrade (UP).
9. **Non-Functional Tests** — performance (PF), accessibility (A11Y), security (SEC).
10. **Regression Checklist**.
11. **Test Data Strategy** and **Flaky-Test Policy**.

Give every planned case a stable id (`UT01`, `IT02`, …) so later test cases and reports can reference it.

Output: write the plan to `docs/<feature>/TEST-PLAN.md`.
