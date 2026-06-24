---
name: aisf-skill-prd
description: Draft or refine a Product Requirements Document (PRD). Focuses on problem/goal, user flows, and testable ACs.
tags: [planning, docs]
---
<!-- ai-stepflow built-in -->

Write a PRD scoped strictly to what the input describes — do not invent features, personas, or analytics not mentioned in the source.

## Scaling rule
- **Small** (≤3 user-facing changes, single flow): emit Goal, User Story, Out-of-Scope, 3-5 Gherkin ACs, Assumptions/Open Questions.
- **Large** (multi-flow, cross-team, or ambiguous scope): add Personas, User Flows (happy + error paths), Non-Functional Requirements (performance, security, accessibility), Technical Constraints, Analytics Events.

When in doubt, start small — a dense 1-page PRD is more useful than a bloated 5-page one.

## Required sections (all sizes)
1. **Goal** — why this exists, the problem it solves.
2. **Out of Scope** — explicitly list what is NOT covered to prevent scope creep.
3. **User Story** — "As a [persona], I want [action] so that [outcome]."
4. **Acceptance Criteria** — Gherkin (Given/When/Then). Every AC must be independently verifiable by QA.
5. **Assumptions & Open Questions** — unresolved decisions or dependencies that could block implementation.

## Rules
- Focus on "What", not "How".
- Every AC must be measurable — no vague terms like "fast", "easy", "correct".
- If the input is a GitHub issue, Jira ticket, Linear task, or plain-text spec, cover only what that source describes.

Write to the path specified in Mandatory Output Files.
