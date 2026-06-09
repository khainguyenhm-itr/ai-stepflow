<!-- ai-stepflow built-in -->
---
name: aisf-implement
description: Implement the approved tech design on a feature branch — write production code that follows the design, project conventions, and acceptance criteria. Stack-neutral (web, mobile, desktop, backend, CLI).
---

Implement the feature in the input, following its approved tech design.

Read first: the tech design, the PRD, the test plan, the project's CLAUDE.md, and the existing code in the area you are changing.

Steps:
1. Create a feature branch (`feature/<short-desc>`).
2. Write unit tests first (red) for the acceptance criteria — see the `unit-test` skill — then write the production code to make them pass (green).
3. Follow the tech design exactly: respect layer boundaries, wire new components where the project expects them, update navigation/registration.
4. Run lint, typecheck, build, and the full unit-test suite locally; fix what breaks.
5. Open a PR referencing the feature.
6. Write a short summary to `docs/<feature>/IMPLEMENT-SUMMARY.md`: branch name, files changed, acceptance criteria covered, tests added, coverage numbers, and any deferred work.

Rules: correct → clear → fast. Keep diffs small. No secrets in code or logs. Validate input at trust boundaries. Parameterize queries. Close what you open. Match existing conventions; flag any divergence from the design instead of improvising.
