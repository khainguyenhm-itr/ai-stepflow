---
name: csf-skill-test-cases
description: Generate detailed, executable test cases from a PRD or Test Plan.
tags: [testing, qa]
---
<!-- claudesteps built-in -->

Generate test cases for the feature. Use this format per case:

```
**ID**: TC-NNN          (zero-padded, sequential, e.g. TC-001)
**Title**: <short description>
**Type**: Unit | Integration | E2E | Manual
**Priority**: P1 (blocker) | P2 (high) | P3 (normal)
**Preconditions**: system state before the test
**Test Data**: specific inputs, fixtures, or env values required
**Steps**: numbered actions
**Expected Result**: exact observable outcome
**AC Ref**: which PRD acceptance criterion this covers
```

## Coverage requirements
- Every PRD AC must have at least one P1 or P2 test case covering it.
- Include: positive (happy path), negative (invalid input), boundary conditions (min/max/empty), and concurrent or error-state scenarios where relevant.
- Security-sensitive flows (auth, payments, permissions): add at least one negative test per access boundary.

## Grouping
Group test cases by feature area. Within each group, order: happy path → boundary → negative → error states.

Write to the path specified in Mandatory Output Files.

## Parallel fan-out
Independent work runs concurrently: dispatch one subagent per slice **in a single message**, then draw the conclusion yourself from their reports.

**Slice this by**: Deriving cases for one feature area, or one AC group, per slice.

- Independent slices only. Anything that depends on another slice's result stays sequential.
- Subagents investigate and report (findings + `file:line`); **you** do every write, so each Mandatory Output File keeps exactly one writer.
- Give each subagent its own explicit scope and ask for a compact report, not a file dump.
- Under a `sandboxed` flow subagents inherit the deny list (no Bash/WebFetch/WebSearch) — keep them read-only.
- One slice, or work you finish in two or three reads? Do it yourself — dispatching costs more than it saves.
