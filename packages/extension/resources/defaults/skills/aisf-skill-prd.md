<!-- ai-stepflow built-in -->
---
name: aisf-skill-prd
description: Draft or refine a Product Requirements Document (PRD). Focuses on problem/goal, user flows, and testable ACs.
---

Generate a comprehensive Product Requirements Document (PRD) for the feature described.

Core Sections:
1. **Context & Goals**: Why are we building this? What is the measurable success criteria?
2. **User Personas**: Who is the target user for this feature?
3. **User Flows**: Detailed happy path and critical error paths.
4. **Acceptance Criteria**: Gherkin-style (Given/When/Then) points. Must be testable.
5. **Technical Constraints**: Non-functional requirements (performance, security, privacy).
6. **Analytics**: What events should we track?

Rules: Focus on "What", not "How". Ensure every AC is verifiable.
Output: Write to `docs/prd/<feature-name>.md`.
