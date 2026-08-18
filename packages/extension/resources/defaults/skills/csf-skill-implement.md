---
name: csf-skill-implement
description: Implement features or fixes. Writes production-quality code and unit tests.
tags: [engineering, coding]
---
<!-- claudesteps built-in -->

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

## Parallel fan-out
Independent work runs concurrently: dispatch one subagent per slice **in a single message**, then draw the conclusion yourself from their reports.

**Slice this by**: Reading existing code — one subsystem, module, or similar-implementation hunt per slice.

- Independent slices only. Anything that depends on another slice's result stays sequential.
- Subagents investigate and report (findings + `file:line`); **you** do every write, so each Mandatory Output File keeps exactly one writer.
- Give each subagent its own explicit scope and ask for a compact report, not a file dump.
- Under a `sandboxed` flow subagents inherit the deny list (no Bash/WebFetch/WebSearch) — keep them read-only.
- One slice, or work you finish in two or three reads? Do it yourself — dispatching costs more than it saves.
