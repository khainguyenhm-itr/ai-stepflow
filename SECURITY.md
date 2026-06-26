# Security Policy

## Supported versions

AI StepFlow is pre-1.0; only the latest released version on the VS Code
Marketplace receives security fixes.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately via GitHub's
[private vulnerability reporting](https://github.com/khainguyenhm-itr/ai-stepflow/security/advisories/new)
(Security → Report a vulnerability). Include:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- affected version(s) and platform.

We aim to acknowledge reports within 5 business days and to provide a remediation
timeline after triage.

## Scope notes

AI StepFlow runs the local `claude` CLI on your behalf and can create or modify
files in your workspace. Be aware of the trust model:

- **Trusted flows** run Claude with your normal interactive permissions — only run
  flows you have reviewed.
- `trustLevel: sandboxed` is **not currently enforced** on the interactive run path
  (see the README "Permissions" note). Treat sandboxed flows as unrestricted until
  this is rewired, and never run untrusted flow definitions.
