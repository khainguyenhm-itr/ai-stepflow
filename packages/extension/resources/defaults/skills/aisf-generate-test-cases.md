<!-- ai-stepflow built-in -->
---
name: aisf-generate-test-cases
description: Generate concrete, executable test cases from the test plan and acceptance criteria. Output is structured TEST-CASES.md plus runnable test files, not prose.
---

Generate concrete test cases for the feature in the input.

Read first: the PRD (acceptance criteria are the canonical inputs), the test plan (categories, scope, matrix), the tech design (file impact), and existing tests for style.

For each acceptance criterion, emit cases grouped by category, using the ids from the test plan (`UT`, `CT`, `IT`, `UI`, `E2E`, …). Each case has: a one-line behavior summary, the acceptance-criterion id it ties to, the type, preconditions, steps, the single expected observable outcome, the test file path, and a status (`drafted` or `implemented`).

Also emit at least one failure-mode case per category that applies (skip a category with a one-line rationale). Keep an index at the top mapping criterion ids to their cases.

Where you can, write the actual runnable test files (not stubs) in the project's test folder, matching its matchers, fixtures, and conventions; put the case id in the test name.

Rules: every case ties to one criterion id or a named risk; deterministic (inject clock, seed, stub network); isolated (owns its data); arrange/act/assert.

Output: write `docs/<feature>/TEST-CASES.md` and commit any generated test source files.
