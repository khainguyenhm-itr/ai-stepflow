<!-- ai-stepflow built-in -->
---
name: sf-implement
description: Implement features or fixes. Writes production-quality code and unit tests.
---

Implement the feature or fix as specified in the PRD and Technical Design.

Process:
1. **Read & Map**: Analyze existing code, CLAUDE.md, and design docs.
2. **Skeleton**: Define types, interfaces, and function signatures first.
3. **Implementation**: Write logic using the "Surgical Changes" principle — only touch what is necessary.
4. **Testing**: Write unit tests to cover happy paths and edge cases.
5. **Verification**: Run tests and verify the code against the Acceptance Criteria.

Rules: No placeholders. No over-engineering. Rigorous type safety.
Output: Source code and unit tests.
