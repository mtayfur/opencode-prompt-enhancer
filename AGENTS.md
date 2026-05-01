# Project Notes

## Scope

This repo contains a single OpenCode TUI plugin that enhances prompt drafts and writes the enhanced text back into the active prompt input.

Primary files:

- `plugins/prompt-enhancer.tsx`: plugin implementation
- `index.ts`: package export

## Local Conventions

- Keep changes small and local to `plugins/prompt-enhancer.tsx` unless packaging or docs require more.
- Prefer preserving current plugin behavior over introducing new abstractions.
- Run `bun run typecheck` after code changes.

## OpenCode TUI Facts

- `TuiRouteCurrent` is usually `home` or `session`; `session.params.sessionID` identifies the active session and `session.params.prompt` is only a seed value.
- `api.route.current.params.prompt` is not the live prompt buffer.
- Capture `TuiPromptRef` to read/write the live prompt. `current` exposes `input`, `mode`, and `parts`; useful methods are `set(...)`, `reset()`, `blur()`, `focus()`, and `submit()`.
- `home_prompt` and `session_prompt` replace the default prompt area. When overriding them, render `api.ui.Prompt`, forward the host `ref`, and pass `home_prompt_right` / `session_prompt_right` through `right={...}`.
- Prompt slots use `replace`; other slot modes are `append` and `single_winner`.
- `api.ui.Prompt` accepts `workspaceID` on home and `sessionID` in sessions, plus `visible`, `disabled`, `onSubmit`, `ref`, `right`, `showPlaceholder`, and `placeholders`.
- `DialogPrompt` can be prefilled with `value`; `busy` and `busyText` exist if a flow needs async feedback.
- `DialogPrompt.onConfirm` returns only the dialog string.
- `api.ui.dialog.replace(...)` swaps the active dialog, `api.ui.dialog.clear()` closes it, and `api.ui.dialog.setSize(...)` controls sizing.

## OpenCode Plugin Facts

- `api.command.register(...)` returns an unregister function. Clean it up in `api.lifecycle.onDispose(...)`.
- `api.slots.register(...)` contributes TUI slot renderers such as `home_prompt` or `session_prompt`.
- `api.lifecycle.signal` should be threaded through async client calls so plugin work stops cleanly on unload.
- `api.state.path.directory` is the current directory to use for TUI client operations.
- `api.state.vcs?.branch` is available without extra shelling out and is cheap context for prompt enhancement.
- Session-scoped lightweight context is available from `api.state.session.messages(sessionID)`, `api.state.session.diff(sessionID)`, and `api.state.session.todo(sessionID)`.
- Message parts can be read from `api.state.part(messageID)`; visible user text should be reconstructed from non-ignored text parts only.
- `api.client.tui.submitPrompt(...)` exists, but prefer `promptRef.submit()` when a prompt ref is available.
- The async TUI prompt APIs can race with user keypresses, so use them only as fallback.

## Prompt Handling

- Store the active prompt ref in plugin state.
- When enhancing from the current prompt, snapshot the full `TuiPromptInfo`, clear the prompt immediately before the async model call, and restore the snapshot on failure.
- Read the current prompt from `promptRef.current.input`.
- Prefill the enhance dialog from the current prompt with `DialogPrompt.value`.
- Replace prompt text with `promptRef.set(...)` when available. Preserve `mode` and non-text `parts`, and drop only text parts unless the feature explicitly wants to remove attachments.
- If no prompt ref is available, fall back to `api.client.tui.clearPrompt(...)` and `api.client.tui.appendPrompt(...)`.

## Workspace Context Policy

- The enhancer should keep context lightweight.
- Current context sources are:
  - working directory
  - branch
  - recent user prompts in the current session
  - changed files in the current session
  - active todos
- Do not add file-content reads to enhancement context unless there is a clear product requirement.

## Validation

- Required after code edits: `bun run typecheck`
- If changing prompt-flow behavior, verify this path mentally or manually:
  1. Enter text in the main prompt.
  2. Press `Ctrl+E`.
  3. Confirm the dialog is prefilled from the main prompt.
  4. Edit the dialog text and submit.
  5. Confirm the main prompt now contains the enhanced text and the stale prompt was not submitted.
