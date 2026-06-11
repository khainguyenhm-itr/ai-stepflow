<!-- ai-stepflow built-in -->
---
name: aisf-refactor
description: Restructure existing code to improve quality without changing behavior.
---

Refactor the specified code area to improve readability, maintainability, or performance.

Goals:
- Remove code duplication (DRY).
- Improve naming and abstractions.
- Simplify complex logic.
- Decouple components.

Rules: Ensure behavior remains identical. Existing tests MUST pass. Write new tests if coverage is low before refactoring.
Output: Refactored source code.
