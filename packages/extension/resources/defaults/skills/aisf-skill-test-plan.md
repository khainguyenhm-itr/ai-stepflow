---
name: aisf-skill-test-plan
description: Create a testing strategy and plan for a feature. Covers functional, integration, and regression testing.
---
<!-- ai-stepflow built-in -->

Draft a Test Plan based on the PRD and TDD.

## Required sections

### 1. Scope
- **In scope**: features and flows being tested.
- **Out of scope**: explicitly excluded areas with reasons.

### 2. Entry & Exit Criteria
- **Entry**: conditions before testing begins (e.g., "implementation merged to feature branch, smoke tests passing").
- **Exit**: conditions to declare testing complete (e.g., "all P1/P2 cases passed, zero open Critical defects").

### 3. Testing Types
For each type applicable to this feature, describe what will be tested:
- Unit, Integration, E2E, Performance, Security, Regression.

### 4. Environment
- Target environment (local / staging / production-like).
- Required services, feature flags, or configuration.
- Test data sources and seeding strategy.

### 5. High-Risk Areas
List areas with elevated failure probability and the mitigation for each.

### 6. Regression Impact
List existing features that could regress and how they will be verified.

### 7. Defect Management
- Severity classification: Critical / Major / Minor.
- Blocking threshold: Critical defects block release; Major defects require product sign-off.

## Rules
- Must cover 100% of PRD Acceptance Criteria — map each AC to at least one testing type.
- No vague scope ("test everything") — each area must be named specifically.

Write to the path specified in Mandatory Output Files.
