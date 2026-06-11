<!-- ai-stepflow built-in -->
---
name: aisf-skill-design
description: Draft a Technical Design Document. Focuses on architecture, data models, API specs, and tradeoffs.
---

Create a Technical Design Document (TDD) for the implementation of the feature/PRD.

Core Sections:
1. **Proposed Solution**: High-level architectural overview.
2. **Data Models**: Schema changes, new entities, and data relationships.
3. **API Design**: Endpoint specs, request/response models, and error codes.
4. **Wiring & Dependencies**: How new components interact with existing ones.
5. **Tradeoffs**: What alternatives were considered? Why was this chosen?
6. **Migration & Rollout**: How to deploy safely? Is a data migration needed?

Rules: Follow existing project patterns. Prefer simplicity and modularity.
Output: Write to `docs/design/<feature-name>.md`.
