<!-- ai-stepflow built-in -->
---
name: aisf-review
description: Perform a technical review of code or designs. Focuses on quality, security, and standards.
---

Review the provided code or design artifact.

Checklist:
- **Correctness**: Does it meet the requirements? Are there bugs?
- **Standards**: Does it follow the project's style and CLAUDE.md?
- **Security**: Any vulnerabilities (XSS, Injection, Secret exposure)?
- **Performance**: Any obvious bottlenecks or inefficient I/O?
- **Maintainability**: Is it easy to read, test, and change?
- **Edge Cases**: Are error states handled?

Rules: Be constructive. Provide specific suggestions for improvement.
Output: Review comments or a summary report.
