# opencode-prompt-enhancer

OpenCode TUI plugin that rewrites rough prompt drafts into clearer, stronger prompts.

## What it does

- Rewrites rough prompt drafts into clearer, stronger prompts.
- Uses lightweight workspace context.
- Keeps the original intent and language, and does not read file contents.

## Context used

The enhancer uses:

- the current working directory
- recent user prompts in the current session
- files changed in the current session

## Install

Add the package to OpenCode's `tui.json` plugin list:

```jsonc
{
  "plugin": [
    "@mtayfur/opencode-prompt-enhancer@latest"
  ]
}
```

OpenCode `>=1.3.14` is required.

## Use

1. Open OpenCode in a workspace.
2. Enter a rough prompt in the TUI prompt.
3. Press `Ctrl+E` or run `/enhance`.
4. Review the prefilled dialog, edit it if needed, and confirm.
5. The enhanced prompt replaces the current input.

## Development

```bash
bun install
bun run typecheck
```
