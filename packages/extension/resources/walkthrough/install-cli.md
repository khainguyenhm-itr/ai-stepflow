## Install the Claude Code CLI

ClaudeSteps runs each step through the local **`claude`** CLI. Install it once,
globally:

```sh
npm install -g @anthropic-ai/claude-code
```

Then confirm it is on your `PATH`:

```sh
claude --version
```

If `claude` is not found, ClaudeSteps will tell you in the step output instead of
failing silently.
