---
name: csf-skill-refactor
description: Restructure existing code to improve quality without changing behavior.
tags: [engineering, refactoring]
---
<!-- claudesteps built-in -->

Refactor the specified code to improve readability, maintainability, or performance — **one goal per run**. Do not mix multiple refactoring objectives.

## Steps
1. **Confirm test coverage** — if coverage is low, write missing tests first. Do not refactor untested code.
2. **Run tests (baseline)** — record the baseline pass/fail state before any change.
3. **Refactor** — scope strictly to the specified files/functions. Do not touch adjacent code unless it is a direct dependency of the refactored unit.
4. **Run tests (post)** — all tests that passed before must still pass. Any new failure = blocking defect.
5. **Record changes** — output a brief changelog: what was restructured and why (one line per logical change).

## Goals (pick the one that applies)
- **Readability**: rename symbols, extract helpers, remove dead code, simplify conditionals.
- **Maintainability**: reduce coupling, eliminate duplication, improve naming consistency.
- **Performance**: reduce unnecessary computation/allocations — profile-guided only, not speculative.

## Rules
- Behavior must be identical before and after.
- Do not add new features or fix unrelated bugs during a refactor pass.

Write to the path specified in Mandatory Output Files.

## Parallel fan-out
Independent work runs concurrently: dispatch one subagent per slice **in a single message**, then draw the conclusion yourself from their reports.

**Slice this by**: Surveying the target's call sites and test coverage — one file group per slice.

- Independent slices only. Anything that depends on another slice's result stays sequential.
- Subagents investigate and report (findings + `file:line`); **you** do every write, so each Mandatory Output File keeps exactly one writer.
- Give each subagent its own explicit scope and ask for a compact report, not a file dump.
- Under a `sandboxed` flow subagents inherit the deny list (no Bash/WebFetch/WebSearch) — keep them read-only.
- One slice, or work you finish in two or three reads? Do it yourself — dispatching costs more than it saves.
