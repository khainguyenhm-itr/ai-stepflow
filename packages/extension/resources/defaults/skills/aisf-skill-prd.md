---
name: aisf-skill-prd
description: Draft or refine a Product Requirements Document (PRD). Focuses on problem/goal, user flows, and testable ACs.
---
<!-- ai-stepflow built-in -->

Write a PRD scoped strictly to what the input describes — do not invent features, personas, or analytics not mentioned in the source.

Scale depth to complexity:
- Small/well-defined issue → emit only: goal, user story, 3-5 Gherkin ACs.
- Large/multi-faceted issue → add personas, user flows (happy + error paths), technical constraints, analytics events as needed.

Focus on "What", not "How". Every AC must be measurable and verifiable by QA.
Write to the path specified in Mandatory Output Files.
