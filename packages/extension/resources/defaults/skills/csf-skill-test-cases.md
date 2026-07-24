---
name: aisf-skill-test-cases
description: Generate detailed, executable test cases from a PRD or Test Plan.
tags: [testing, qa]
---
<!-- ai-stepflow built-in -->

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
