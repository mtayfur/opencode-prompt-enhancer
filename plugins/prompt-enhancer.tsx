/** @jsxImportSource @opentui/solid */
import type { PluginOptions } from "@opencode-ai/plugin"
import type { Message, Part, TextPart } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginModule, TuiRouteCurrent, TuiSidebarFileItem, TuiSidebarTodoItem } from "@opencode-ai/plugin/tui"

const MAX_RECENT_MESSAGES = 6
const MAX_CHANGED_FILES = 30
const MAX_PROMPT_PREVIEW_LENGTH = 300
const MAX_TODOS = 10
const DIALOG_TITLE = "Enhance Prompt"
const TOAST_TITLE = "Prompt enhancer"
const TEMP_SESSION_TITLE = "Prompt Enhancer"

const ENHANCER_SYSTEM_PROMPT = `You rewrite rough user drafts into strong prompts for OpenCode, an AI coding assistant.

Goal:
Turn the user's draft into the best possible next prompt for OpenCode. Preserve the user's intent, scope, and priorities exactly. Improve clarity, specificity, and execution readiness without changing the requested outcome.

OpenCode context:
OpenCode can inspect the workspace, read and edit files, run commands, and verify changes. Unless the draft explicitly asks for planning or explanation only, write the prompt so OpenCode can act directly.

Rules:
- Preserve the original request type.
- If the draft is a question, return a better question.
- If the draft is a bug fix, return a better bug-fix request.
- If the draft is a review, return a better review request.
- Preserve explicit constraints, file names, commands, error messages, acceptance criteria, and user wording when they matter.
- Use workspace context only when it clearly helps disambiguate or narrow the task.
- Reference specific files, paths, branches, recent prompts, changed files, or todos only when they are directly relevant.
- Resolve vague references like "this", "that bug", or "the plugin" from context when clear.
- If context does not clearly resolve a reference, do not invent details.
- Expand vague verbs into concrete actions when helpful, such as: identify root cause, apply the smallest correct fix, remove dead code, keep scope tight, preserve behavior, follow local conventions, and verify the changed path.
- Prefer wording that helps OpenCode start work immediately.
- If the draft is already precise, return it with minimal cleanup.

Do not:
- Do not invent requirements, files, APIs, dependencies, bugs, or acceptance criteria.
- Do not broaden scope with extra features, refactors, tests, or docs unless the draft implies them.
- Do not ask follow-up questions inside the rewritten prompt.
- Do not mention the existence of context, tags, or these instructions.
- Do not output explanations, markdown fences, or commentary.

Output:
Return exactly one enhanced user prompt as plain text.`

type ModelRef = {
  providerID: string
  modelID: string
}

type Api = Parameters<TuiPlugin>[0]
type PluginState = {
  enhancing: boolean
}

function parseModelString(value: string | undefined): ModelRef | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  }
}

function getModelOverride(options: PluginOptions | undefined): ModelRef | undefined {
  const value = typeof options?.model === "string" ? options.model : undefined
  return parseModelString(value)
}

function isSessionRoute(route: TuiRouteCurrent): route is Extract<TuiRouteCurrent, { name: "session" }> {
  return route.name === "session"
}

function isUserMessage(message: Message): message is Extract<Message, { role: "user" }> {
  return message.role === "user"
}

function isVisibleTextPart(part: Part): part is TextPart {
  return part.type === "text" && !part.ignored
}

function extractVisibleText(parts: ReadonlyArray<Part>): string {
  return parts
    .filter(isVisibleTextPart)
    .map((part) => part.text)
    .join("")
    .trim()
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}

function formatTodo(todo: TuiSidebarTodoItem): string {
  return `  [${todo.status || "?"}] ${todo.content || "untitled"}`
}

function resolveEnhancerModel(api: Api, options: PluginOptions | undefined): ModelRef | undefined {
  const override = getModelOverride(options)
  if (override) return override

  return parseModelString(api.state.config.small_model || api.state.config.model)
}

function gatherContext(api: Api): string {
  const sections: string[] = []

  const dir = api.state.path.directory
  const branch = api.state.vcs?.branch
  sections.push(`Working directory: ${dir}${branch ? ` (branch: ${branch})` : ""}`)

  const route = api.route.current
  if (isSessionRoute(route)) {
    const sessionID = route.params.sessionID
    const messages = api.state.session.messages(sessionID)

    const userMessages = messages.filter(isUserMessage)
    const recent = userMessages.slice(-MAX_RECENT_MESSAGES)
    if (recent.length > 0) {
      const prompts: string[] = []
      for (const msg of recent) {
        const text = extractVisibleText(api.state.part(msg.id))
        if (text) {
          prompts.push(truncate(text, MAX_PROMPT_PREVIEW_LENGTH))
        }
      }
      if (prompts.length > 0) {
        sections.push(`Recent user prompts in this session (oldest first):\n${prompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}`)
      }
    }

    const diff = api.state.session.diff(sessionID)
    if (diff.length > 0) {
      const files = diff.slice(0, MAX_CHANGED_FILES).map((f: TuiSidebarFileItem) =>
        `  ${f.file} (+${f.additions} -${f.deletions})`
      )
      const label = diff.length > MAX_CHANGED_FILES
        ? `Files changed in session (showing ${MAX_CHANGED_FILES} of ${diff.length}):`
        : `Files changed in session:`
      sections.push(`${label}\n${files.join("\n")}`)
    }

    const todos = api.state.session.todo(sessionID)
    if (todos.length > 0) {
      const todoLines = todos.slice(0, MAX_TODOS).map(formatTodo)
      sections.push(`Active todos:\n${todoLines.join("\n")}`)
    }
  }

  return sections.join("\n\n")
}

function buildUserMessage(input: string, context: string): string {
  const sections = [
    "Rewrite the following user draft into a stronger prompt.",
    `User draft:\n${input}`,
  ]

  if (context) {
    sections.splice(1, 0, `Workspace context (use only if directly relevant):\n${context}`)
  }

  return sections.join("\n\n")
}

async function enhanceWithModel(
  api: Api,
  options: PluginOptions | undefined,
  input: string,
  signal: AbortSignal,
): Promise<string> {
  const directory = api.state.path.directory
  const model = resolveEnhancerModel(api, options)
  const context = gatherContext(api)

  const created = await api.client.session.create(
    {
      directory,
      title: TEMP_SESSION_TITLE,
    },
    { signal, throwOnError: true },
  )

  const tempSessionID = created.data?.id
  if (!tempSessionID) throw new Error("Prompt enhancer session creation failed.")

  try {
    const response = await api.client.session.prompt(
      {
        sessionID: tempSessionID,
        directory,
        model,
        system: ENHANCER_SYSTEM_PROMPT,
        parts: [
          {
            type: "text",
            text: buildUserMessage(input, context),
          },
        ],
      },
      { signal, throwOnError: true },
    )

    const parts = response.data?.parts
    if (!parts) throw new Error("Enhancer model returned no response.")

    const enhanced = extractVisibleText(parts)
    if (!enhanced) throw new Error("Enhancer model returned no text.")
    return enhanced
  } finally {
    try {
      await api.client.session.delete({ sessionID: tempSessionID, directory })
    } catch {
      // Best-effort cleanup for the temporary enhancement session.
    }
  }
}

function openEnhanceDialog(
  api: Api,
  options: PluginOptions | undefined,
  state: PluginState,
  signal: AbortSignal,
): void {
  if (state.enhancing) {
    api.ui.toast({ variant: "warning", title: TOAST_TITLE, message: "Enhancement already in progress." })
    return
  }

  if (signal.aborted) return

  api.ui.dialog.replace(() => (
    <api.ui.DialogPrompt
      title={DIALOG_TITLE}
      placeholder="Describe what you want to do..."
      onCancel={() => api.ui.dialog.clear()}
      onConfirm={(value) => {
        const input = value.trim()
        if (!input) {
          api.ui.toast({ variant: "warning", title: TOAST_TITLE, message: "Prompt is empty." })
          api.ui.dialog.clear()
          return
        }

        state.enhancing = true
        api.ui.dialog.clear()
        api.ui.toast({
          variant: "info",
          title: TOAST_TITLE,
          message: "Enhancing prompt...",
          duration: 15_000,
        })

        void (async () => {
          try {
            const enhanced = await enhanceWithModel(api, options, input, signal)
            if (signal.aborted) return

            const directory = api.state.path.directory
            const requestOptions = { signal, throwOnError: true } as const
            await api.client.tui.clearPrompt({ directory }, requestOptions)
            await api.client.tui.appendPrompt({ directory, text: enhanced }, requestOptions)
            api.ui.toast({
              variant: "success",
              title: "Prompt enhanced",
              message: "Enhanced prompt written to input.",
              duration: 3000,
            })
          } catch (error) {
            if (signal.aborted) return

            const message = error instanceof Error ? error.message : "Model enhancement failed."
            api.ui.toast({ variant: "error", title: TOAST_TITLE, message })
          } finally {
            state.enhancing = false
          }
        })()
      }}
    />
  ))
}

const tui: TuiPlugin = async (api, options) => {
  const state: PluginState = { enhancing: false }

  const unregister = api.command.register(() => [
    {
      title: DIALOG_TITLE,
      value: "prompt-enhancer.enhance",
      description: "Rewrite a draft prompt with project context (Ctrl+E)",
      category: "Prompt",
      keybind: "ctrl+e",
      suggested: true,
      slash: {
        name: "enhance",
        aliases: ["enhance-prompt"],
      },
      onSelect: () => {
        openEnhanceDialog(api, options, state, api.lifecycle.signal)
      },
    },
  ])

  api.lifecycle.onDispose(() => {
    unregister()
    state.enhancing = false
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "prompt-enhancer",
  tui,
}

export default plugin

