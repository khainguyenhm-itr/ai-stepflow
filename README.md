# AI StepFlow

A Claude Flow Cockpit for structured AI workflows in VS Code. Manage your Claude
agents, skills, and multi-step workflows in one place — then run each step through
the Claude CLI without leaving the editor.

## Features

- **One cockpit for everything** — browse Global (`~/.claude`) and project-level
  (`.claude`) agents, skills, and flows side by side, filtered by scope.
- **Visual workflow builder** — create multi-step flows, assign an agent and one
  or more skills per step, declare run inputs, set dependencies between steps,
  and reorder steps by drag-and-drop.
- **Step runner** — each step runs its skills as headless `claude -p` processes,
  in order. Output streams into the cockpit console and every skill reports its
  own real exit code; a step only completes when all of its skills exit cleanly.
- **Human and AI review** — gate a step on a human approve/reject, or on an
  automated AI review that reads the step output (or a configured review file
  and checklist) and returns a verdict.
- **Artifact gates** — declare `requires`, `produces`, and `producesContains`
  checks so a step cannot start or be marked done unless the expected files and
  markers are present.
- **Run persistence** — in-progress runs are saved per project and restored when
  you reopen the cockpit, so a window reload never loses your place.
- **Headless CLI** — drive a flow from scripts or CI, including human-review
  gates via `approve`, `reject`, and `mark-done`.
- **Create from scratch or import** — author agents/skills in the UI, draft a
  system prompt or skill body with Claude, or import an existing markdown file.
- **GitNexus integration** — when the `gitnexus` MCP server is connected, a
  GitNexus control appears in **Project Settings**: build/refresh the repo's
  knowledge graph (Analyze / Re-analyze), see index freshness, join the repo to a
  multi-repo **group**, and open the registry/group config files directly.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) on your `PATH`:
  ```sh
  npm install -g @anthropic-ai/claude-code
  ```
- _(Optional)_ [GitNexus](https://www.npmjs.com/package/gitnexus) — enables the
  GitNexus panel in **Project Settings**. Install it globally and register its MCP
  server with Claude so the extension can detect the connection:
  ```sh
  npm install -g gitnexus
  claude mcp add gitnexus -- gitnexus mcp
  ```
  The GitNexus control only appears once the `gitnexus` MCP server shows as
  connected in the **MCP Connections** panel.

## Getting started

1. Open the **AI StepFlow** icon in the activity bar, or run **Open AI StepFlow**
   from the command palette.
2. Pick a workflow and press **Run**, or create a new one with **New Flow**.
3. Run each step from the runner panel and review the streamed output.

## How a step runs

Each skill in a step is invoked as its own `claude -p "/skill-name <input>"`
process in the project directory. Steps run their skills sequentially and stop on
the first non-zero exit code. Headless runs use the `acceptEdits` permission mode
so a non-interactive run does not stall waiting for a prompt that cannot be
answered. **⚠ This means a headless (AI-reviewed) step can create or modify files
in your project without asking for confirmation** — run flows you trust, and review
the diff afterwards. A hung run is killed after `ai-stepflow.run.timeoutSeconds`
(default 600s; set to 0 to disable), and you can stop one early with the **Cancel**
button. Ad-hoc **Run agent** / **Run skill** actions instead open an interactive
Claude session in the integrated terminal.

Steps run only when every id in `dependsOn` is already `done`. New steps created
from the UI depend on the previous step by default, and the step editor lets you
adjust dependencies explicitly. When a step finishes and unlocks several dependents
at once, every headless (AI-reviewed) branch auto-starts in parallel; interactive
steps share one terminal, so the first opens and the rest wait for you to launch them.

Before a step starts, every path in `requires` must exist. Put any markdown/spec
file that the step must read before running in `requires`; mentioning a filename
inside a prompt is not treated as a file gate. After a step finishes, every path
in `produces` must exist, and each value in `producesContains` must be found in
at least one produced file. A configured `review.filePath` is also checked as an
expected post-run artifact. Paths may include run-input placeholders such as
`{feature}`; placeholders are resolved from the inputs collected when the run
starts.

AI review uses two layers. First, a deterministic validator module checks the
artifacts. Then, when `review.deep` is not `false`, Claude reviews the produced
artifact text with the installed review kit. If the review kit, artifacts, or a
validator-only setup are missing, the step waits for human review instead of being
approved automatically.

## CLI

The packaged extension exposes an `ai-stepflow` command for headless runs:

```sh
ai-stepflow run --project . --flow .claude/flows/example.yaml --input feature=login
ai-stepflow verify --project . --flow .claude/flows/example.yaml --run .claude-flow/runs/example-run.json
ai-stepflow report --project . --flow .claude/flows/example.yaml --run .claude-flow/runs/example-run.json
ai-stepflow approve --project . --flow .claude/flows/example.yaml --run .claude-flow/runs/example-run.json --step review --comment "Looks good"
ai-stepflow reject --project . --flow .claude/flows/example.yaml --run .claude-flow/runs/example-run.json --step review --comment "Needs changes"
ai-stepflow mark-done --project . --flow .claude/flows/example.yaml --run .claude-flow/runs/example-run.json --step implement
```

`run` exits `3` when it reaches a human gate that cannot be completed headlessly.
`approve` records the human approval and marks the step done in one command.
`verify` checks whether declared produced files and markers still match the saved
run state. `report` writes a markdown report under `.claude-flow/reports` unless
`--out` is provided.

## GitNexus

[GitNexus](https://www.npmjs.com/package/gitnexus) builds a per-repo knowledge
graph (symbols, call edges, execution flows) and can link several repos into a
**group** to extract cross-repo contracts (e.g. API calls between services). When
its MCP server is connected, AI StepFlow surfaces it directly in **Project
Settings** so you never leave the editor.

**Install & connect** (global):

```sh
npm install -g gitnexus
claude mcp add gitnexus -- gitnexus mcp
```

Reload the window; the GitNexus row appears in **Project Settings** once the
`gitnexus` server is connected. From there you can:

- **Analyze / Re-analyze** — run `gitnexus analyze` to build or refresh the
  index. A status dot shows whether the index is up to date (green) or stale after
  code changes (yellow); `analyze` is per-repo and does **not** depend on groups.
- **Group select** — `Default (no group)`, any existing group, or
  `＋ Create new group…`. Picking a group adds this repo, re-indexes, and runs
  `group sync`; picking `Default` removes the repo from its group. Joining a group
  requires the repo to be analyzed first.
- **··· menu** — open the GitNexus **registry file** (`~/.gitnexus/registry.json`)
  or the current **group config** (`~/.gitnexus/groups/<name>/group.yaml`) in the
  editor.

## Commands

| Command | Description |
| --- | --- |
| `Open AI StepFlow` | Open the cockpit |
| `Refresh All` | Reload agents, skills, and flows from disk |
| `Install Default Agents & Skills` | Install the bundled SDLC agents, skills, and Karpathy rules into `~/.claude` |
| `AI StepFlow: Rescan AST Graph` | Re-index the workspace with `ast-graph` |
| `AI StepFlow: Re-register AST Graph MCP Server` | Re-register the `ast-graph` MCP server with Claude |

## License

MIT — see [LICENSE](./LICENSE).
