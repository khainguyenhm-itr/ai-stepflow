---
name: aisf-skill-test-cases
description: Generate detailed, executable test cases from a PRD or Test Plan.
---
<!-- ai-stepflow built-in -->

Generate test cases for the feature. Format per case:
- **ID**: TC-XXX
- **Title**: short description
- **Preconditions**: system state before the test
- **Steps**: numbered actions
- **Expected Result**: what should happen
- **AC Ref**: which PRD acceptance criterion this covers

Group by functionality. Include positive and negative scenarios.
Write to the path specified in Mandatory Output Files.
