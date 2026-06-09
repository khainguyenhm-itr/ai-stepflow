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
- **Run persistence** — in-progress runs are saved per project and restored when
  you reopen the cockpit, so a window reload never loses your place.
- **Create from scratch or import** — author agents/skills in the UI, draft a
  system prompt or skill body with Claude, or import an existing markdown file.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) on your `PATH`:
  ```sh
  npm install -g @anthropic-ai/claude-code
  ```

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
answered. Ad-hoc **Run agent** / **Run skill** actions instead open an interactive
Claude session in the integrated terminal.

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
