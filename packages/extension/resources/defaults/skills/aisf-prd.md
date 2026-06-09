<!-- ai-stepflow built-in -->
---
name: aisf-prd
description: Write or review a PRD (Product Requirements Document) — problem and goal, user flows, testable acceptance criteria, non-functional requirements, and analytics events.
---

Write a Product Requirements Document for the feature described in the input.

Read first: any existing epic/feature notes, related prior features, and relevant domain docs.

Produce a PRD with these sections:
1. **Problem & Goal** — the user problem, who has it, why it matters, the measurable goal.
2. **User Flow** — happy path, plus error and recovery paths.
3. **Acceptance Criteria** — numbered (AC01, AC02, …), each testable and written Given/When/Then. Make error states explicit. No vague wording, no AND-chaining.
4. **UI / Design** — link the design or describe concrete UI requirements.
5. **Non-Functional Requirements** — performance, reliability, security/privacy, compatibility, accessibility, i18n, observability, offline.
6. **Analytics / Telemetry** — the events to emit and what each measures.
7. **Dependencies** — upstream/downstream work this relies on.
8. **Rollout** — strategy, success metrics, guardrails, kill-switch.

Rules: describe the "what", not the "how". Quantify success. Every acceptance criterion must be verifiable by QA without guessing.

Output: write the PRD to `docs/<feature>/PRD.md`.
