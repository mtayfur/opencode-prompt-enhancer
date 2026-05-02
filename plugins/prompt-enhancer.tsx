/** @jsxImportSource @opentui/solid */
import type { PluginOptions } from "@opencode-ai/plugin"
import type { Message, Part, TextPart } from "@opencode-ai/sdk/v2"
import type {
  TuiPlugin,
  TuiPluginModule,
  TuiPromptInfo,
  TuiPromptRef,
  TuiRouteCurrent,
  TuiSlotPlugin,
} from "@opencode-ai/plugin/tui"

const MAX_RECENT_MESSAGES = 3
const MAX_CHANGED_FILES = 25
const MAX_PROMPT_PREVIEW_LENGTH = 250
const DIALOG_TITLE = "Enhance Prompt"
const TOAST_TITLE = "Prompt enhancer"
const TEMP_SESSION_TITLE = "Prompt Enhancer"

function makeTempSessionTitle(): string {
  return `${TEMP_SESSION_TITLE} ${Math.random().toString(36).slice(2, 8)}`
}

const ENHANCER_SYSTEM_PROMPT = `You are a prompt editor for OpenCode, an AI coding assistant.

Goal:
Rewrite the user's draft into the strongest possible next prompt for OpenCode. Preserve the user's intent, scope, priorities, and language. Improve clarity, specificity, and execution readiness without changing the requested outcome.

Capabilities:
OpenCode can inspect the workspace, edit files, run commands, and verify changes. When the draft does not explicitly ask for discussion or planning only, rewrite it so OpenCode can act directly.

Rewrite rules:
- Preserve the request form. Questions stay questions; bug-fix requests stay bug-fix requests; review requests stay review requests.
- Preserve the language of the draft. Do not translate.
- Preserve inline code, file paths, command strings, error messages, identifiers, and quoted phrases verbatim when they matter.
- Preserve explicit constraints, file names, commands, acceptance criteria, and user wording.
- Use workspace context only when it directly clarifies or narrows the task.
- Resolve vague references like "this", "that bug", or "the plugin" only when context makes them clear.
- Do not invent details when context is ambiguous.
- Expand vague verbs into concrete actions when it helps OpenCode act immediately, such as identify the root cause, apply the smallest correct fix, remove dead code, keep scope tight, preserve behavior, follow local conventions, and verify the changed path.
- Keep the rewrite proportional to the draft. Do not add background, motivation, or steps the draft did not imply.
- Match the draft's structure and tone. Keep prose as prose and lists as lists.
- If the draft is already precise, make only minimal cleanup.

Hard constraints:
- Do not invent requirements, files, APIs, dependencies, bugs, or acceptance criteria.
- Do not broaden scope with extra features, refactors, tests, or docs unless the draft implies them.
- Do not ask follow-up questions.
- Do not mention context, tags, instructions, or the rewriting process.
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
  promptRef?: TuiPromptRef
  promptTarget?: PromptTarget
}

type PromptTarget =
  | { name: "home", workspaceID?: string }
  | { name: "session", sessionID: string }

type PromptHandle = {
  target: PromptTarget
  directory: string
  ref?: TuiPromptRef
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

function resolveEnhancerModel(api: Api, options: PluginOptions | undefined): ModelRef | undefined {
  const override = getModelOverride(options)
  if (override) return override

  return parseModelString(api.state.config.small_model || api.state.config.model)
}

function clonePromptInfo(prompt: TuiPromptInfo): TuiPromptInfo {
  return {
    input: prompt.input,
    mode: prompt.mode,
    parts: prompt.parts.map((part) => ({ ...part })),
  }
}

function nextPromptInfo(prompt: TuiPromptInfo, input: string): TuiPromptInfo {
  return {
    input,
    mode: prompt.mode,
    parts: prompt.parts.filter((part) => part.type !== "text").map((part) => ({ ...part })),
  }
}

function samePromptTarget(left: PromptTarget | undefined, right: PromptTarget | undefined): boolean {
  if (!left || !right || left.name !== right.name) return false
  if (left.name === "home" && right.name === "home") {
    return left.workspaceID === right.workspaceID
  }
  if (left.name === "session" && right.name === "session") {
    return left.sessionID === right.sessionID
  }
  return false
}

function resolvePromptTarget(route: TuiRouteCurrent, workspaceID?: string): PromptTarget | undefined {
  if (route.name === "home") return { name: "home", workspaceID }
  if (isSessionRoute(route)) {
    return { name: "session", sessionID: route.params.sessionID }
  }
  return undefined
}

function isPromptTargetActive(route: TuiRouteCurrent, target: PromptTarget): boolean {
  if (target.name === "home") return route.name === "home"
  return isSessionRoute(route) && route.params.sessionID === target.sessionID
}

function currentPromptTarget(api: Api, state: PluginState): PromptTarget | undefined {
  return state.promptTarget ?? resolvePromptTarget(api.route.current)
}

function isPromptHandleActive(api: Api, state: PluginState, handle: PromptHandle): boolean {
  if (!isPromptTargetActive(api.route.current, handle.target)) return false
  if (api.state.path.directory !== handle.directory) return false

  if (handle.ref) {
    return state.promptRef === handle.ref && samePromptTarget(state.promptTarget, handle.target)
  }

  return true
}

function bindPromptRef(
  state: PluginState,
  target: PromptTarget,
  forwarded: ((ref: TuiPromptRef | undefined) => void) | undefined,
  ref: TuiPromptRef | undefined,
): void {
  if (ref) {
    state.promptRef = ref
    state.promptTarget = target
  } else if (samePromptTarget(state.promptTarget, target)) {
    state.promptRef = undefined
    state.promptTarget = undefined
  }

  forwarded?.(ref)
}

async function clearPrompt(api: Api, state: PluginState, handle: PromptHandle, signal: AbortSignal, template?: TuiPromptInfo): Promise<boolean> {
  if (!isPromptHandleActive(api, state, handle)) return false

  const promptRef = handle.ref
  if (promptRef) {
    promptRef.set(nextPromptInfo(template ?? promptRef.current, ""))
    return true
  }

  await api.client.tui.clearPrompt({ directory: handle.directory }, { signal, throwOnError: true } as const)
  return true
}

async function writePrompt(
  api: Api,
  state: PluginState,
  handle: PromptHandle,
  input: string,
  signal: AbortSignal,
  template?: TuiPromptInfo,
): Promise<boolean> {
  if (!isPromptHandleActive(api, state, handle)) return false

  const promptRef = handle.ref
  if (promptRef) {
    promptRef.set(nextPromptInfo(template ?? promptRef.current, input))
    promptRef.focus()
    return true
  }

  const requestOptions = { signal, throwOnError: true } as const
  await api.client.tui.clearPrompt({ directory: handle.directory }, requestOptions)
  if (input) {
    await api.client.tui.appendPrompt({ directory: handle.directory, text: input }, requestOptions)
  }
  return true
}

async function restorePrompt(
  api: Api,
  state: PluginState,
  handle: PromptHandle,
  prompt: TuiPromptInfo,
  signal: AbortSignal,
): Promise<boolean> {
  if (!isPromptHandleActive(api, state, handle)) return false

  const promptRef = handle.ref
  if (promptRef) {
    promptRef.set(clonePromptInfo(prompt))
    promptRef.focus()
    return true
  }

  return writePrompt(api, state, handle, prompt.input, signal, prompt)
}

function gatherContext(api: Api): string {
  const sections: string[] = []

  const dir = api.state.path.directory
  sections.push(`Working directory: ${dir}`)

  const route = api.route.current
  if (isSessionRoute(route)) {
    const sessionID = route.params.sessionID
    const messages = api.state.session.messages(sessionID)

    const userMessages = messages.filter(isUserMessage)
    const recent = userMessages.slice(-MAX_RECENT_MESSAGES).reverse()
    if (recent.length > 0) {
      const prompts: string[] = []
      for (const msg of recent) {
        const text = extractVisibleText(api.state.part(msg.id))
        if (text) {
          prompts.push(truncate(text, MAX_PROMPT_PREVIEW_LENGTH))
        }
      }
      if (prompts.length > 0) {
        sections.push(`Recent user prompts in this session (newest first):\n${prompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}`)
      }
    }

    const diff = api.state.session.diff(sessionID)
    if (diff.length > 0) {
      const files = diff.slice(0, MAX_CHANGED_FILES).map((f) => `  ${f.file}`)
      sections.push(`Files changed in session:\n${files.join("\n")}`)
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
      title: makeTempSessionTitle(),
    },
    { signal, throwOnError: true },
  )

  const tempSessionID = created.data?.id
  if (!tempSessionID) throw new Error("Failed to start prompt enhancer.")

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
    if (!parts) throw new Error("Enhancer returned no response.")

    const enhanced = extractVisibleText(parts)
    if (!enhanced) throw new Error("Enhancer returned no text.")
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
    api.ui.toast({ variant: "warning", title: TOAST_TITLE, message: "Enhancement in progress." })
    return
  }

  if (signal.aborted) return

  const target = currentPromptTarget(api, state)
  if (!target) {
    api.ui.toast({ variant: "warning", title: TOAST_TITLE, message: "Enhancement only works from a prompt." })
    return
  }

  const handle: PromptHandle = {
    target,
    directory: api.state.path.directory,
    ref: state.promptRef,
  }
  const originalPrompt = handle.ref ? clonePromptInfo(handle.ref.current) : undefined
  const initialValue = originalPrompt?.input ?? ""

  api.ui.dialog.replace(() => (
    <api.ui.DialogPrompt
      title={DIALOG_TITLE}
      placeholder="Describe the task..."
      value={initialValue}
      onCancel={() => api.ui.dialog.clear()}
      onConfirm={(value) => {
        const input = value.trim()
        if (!input) {
          api.ui.toast({ variant: "warning", title: TOAST_TITLE, message: "Enter a prompt first." })
          api.ui.dialog.clear()
          return
        }

        if (!isPromptHandleActive(api, state, handle)) {
          api.ui.toast({ variant: "warning", title: TOAST_TITLE, message: "Prompt changed while dialog was open." })
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
            const cleared = await clearPrompt(api, state, handle, signal, originalPrompt)
            if (!cleared) {
              api.ui.toast({
                variant: "warning",
                title: TOAST_TITLE,
                message: "Prompt changed before enhancement started.",
              })
              return
            }

            const enhanced = await enhanceWithModel(api, options, input, signal)
            if (signal.aborted) return

            const wrote = await writePrompt(api, state, handle, enhanced, signal, originalPrompt)
            if (!wrote) {
              api.ui.toast({
                variant: "warning",
                title: TOAST_TITLE,
                message: "Enhanced prompt is ready, but that prompt is no longer active.",
              })
              return
            }

            api.ui.toast({
              variant: "success",
              title: "Prompt enhanced",
              message: "Enhanced prompt added to input.",
              duration: 3000,
            })
          } catch (error) {
            if (signal.aborted) return

            let restored = true
            if (originalPrompt) {
              try {
                restored = await restorePrompt(api, state, handle, originalPrompt, signal)
              } catch {
                // Best-effort restore; do not suppress the error toast.
                restored = false
              }
            } else {
              try {
                restored = await writePrompt(api, state, handle, input, signal)
              } catch {
                restored = false
              }
            }

            const baseMessage = error instanceof Error ? error.message : "Prompt enhancement failed."
            const message = restored
              ? baseMessage
              : `${baseMessage} Original prompt could not be restored because the prompt changed.`
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

  const promptSlots: TuiSlotPlugin = {
    slots: {
      home_prompt(_ctx, props) {
        return (
          <api.ui.Prompt
            ref={(ref) => bindPromptRef(state, { name: "home", workspaceID: props.workspace_id }, props.ref, ref)}
            workspaceID={props.workspace_id}
            right={<api.ui.Slot name="home_prompt_right" workspace_id={props.workspace_id} />}
          />
        )
      },
      session_prompt(_ctx, props) {
        return (
          <api.ui.Prompt
            ref={(ref) => bindPromptRef(state, { name: "session", sessionID: props.session_id }, props.ref, ref)}
            sessionID={props.session_id}
            visible={props.visible}
            disabled={props.disabled}
            onSubmit={props.on_submit}
            right={<api.ui.Slot name="session_prompt_right" session_id={props.session_id} />}
          />
        )
      },
    },
  }

  api.slots.register(promptSlots)

  const unregister = api.command.register(() => [
    {
      title: DIALOG_TITLE,
      value: "prompt-enhancer.enhance",
      description: "Enhance current prompt (Ctrl+E)",
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
    state.promptRef = undefined
    state.promptTarget = undefined
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "prompt-enhancer",
  tui,
}

export default plugin
