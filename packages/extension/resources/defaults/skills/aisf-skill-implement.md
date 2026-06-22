---
name: aisf-skill-implement
description: Implement features or fixes. Writes production-quality code and unit tests.
---
<!-- ai-stepflow built-in -->

Implement the feature per the PRD and TDD.

## Steps
1. **Read inputs** — read the PRD (acceptance criteria) and TDD (design) from Mandatory Input Files. If neither exists, infer requirements from the task description and state your assumptions explicitly before writing any code.
2. **Read existing code** — grep for similar implementations; reuse before writing new.
3. **Define types/interfaces first** — no implementation before types are stable.
4. **Write logic** — surgical changes only. Only touch files strictly required by the task.
5. **Write tests** — unit tests for happy paths and edge cases; integration tests for cross-boundary flows.
6. **Verify** — run tests, linter, and type-checker. All must pass before finishing.

## Rules
- No placeholders, stubs, or `throw new Error('not implemented')`.
- No over-engineering — no abstractions beyond what the current ACs require.
- Every AC in the PRD must have at least one test that covers it.

Write implementation files as required. No separate output file needed unless specified in Mandatory Output Files.
