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
import { ENHANCER_SYSTEM_PROMPT } from "./enhancer-system-prompt"

const MAX_RECENT_MESSAGES = 3
const MAX_CHANGED_FILES = 25
const MAX_PROMPT_PREVIEW_LENGTH = 250
const DIALOG_TITLE = "Enhance Prompt"
const TOAST_TITLE = "Prompt enhancer"

type ModelRef = {
  providerID: string
  modelID: string
}

type Api = Parameters<TuiPlugin>[0]
type PluginState = {
  enhancing: boolean
  promptRef?: TuiPromptRef
  promptTarget?: PromptTarget
  lastOriginal?: TuiPromptInfo
  lastEnhancedInput?: string
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

function isSessionRoute(route: TuiRouteCurrent): route is Extract<TuiRouteCurrent, { name: "session" }> {
  return route.name === "session"
}

function extractVisibleText(parts: ReadonlyArray<Part>): string {
  return parts
    .filter((part): part is TextPart => part.type === "text" && !part.ignored)
    .map((part) => part.text)
    .join("")
    .trim()
}

function resolveEnhancerModel(api: Api, options: PluginOptions | undefined): ModelRef | undefined {
  const override = typeof options?.model === "string" ? parseModelString(options.model) : undefined
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

function isPromptHandleActive(api: Api, state: PluginState, handle: PromptHandle): boolean {
  const route = api.route.current
  const target = handle.target
  if (target.name === "home") {
    if (route.name !== "home") return false
  } else if (!isSessionRoute(route) || route.params.sessionID !== target.sessionID) {
    return false
  }
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

  return false
}

function gatherContext(api: Api): string {
  const sections: string[] = []

  const dir = api.state.path.directory
  sections.push(`Working directory: ${dir}`)

  const branch = api.state.vcs?.branch
  if (branch) {
    sections.push(`Current branch: ${branch}`)
  }

  const route = api.route.current
  if (isSessionRoute(route)) {
    const sessionID = route.params.sessionID
    const messages = api.state.session.messages(sessionID)

    const userMessages = messages.filter((message): message is Extract<Message, { role: "user" }> => message.role === "user")
    const recent = userMessages.slice(-MAX_RECENT_MESSAGES).reverse()
    if (recent.length > 0) {
      const prompts: string[] = []
      for (const msg of recent) {
        const text = extractVisibleText(api.state.part(msg.id))
        if (text) {
          prompts.push(text.length > MAX_PROMPT_PREVIEW_LENGTH ? `${text.slice(0, MAX_PROMPT_PREVIEW_LENGTH)}...` : text)
        }
      }
      if (prompts.length > 0) {
        sections.push(`Recent user prompts in this session (newest first):\n${prompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}`)
      }
    }

    const diff = api.state.session.diff(sessionID)
    if (diff.length > 0) {
      const files = diff.slice(0, MAX_CHANGED_FILES).map((f) => `  @${f.file}`)
      sections.push(`Files changed in session:\n${files.join("\n")}`)
    }


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
  const userMessage = [
    "Rewrite the developer draft below into a clear, direct prompt for a coding agent. Preserve the original intent, scope, and mode. Only make references more specific when the context section supports it.",
    `--- CONTEXT (metadata only — resolve draft references, do not invent) ---\n${context}\n---`,
    `--- DRAFT ---\n${input}\n---`,
  ].join("\n\n")

  const created = await api.client.session.create(
    {
      directory,
      title: `Prompt Enhancer ${Math.random().toString(36).slice(2, 8)}`,
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
            text: userMessage,
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

  const target = state.promptTarget ?? (api.route.current.name === "home"
    ? { name: "home" as const }
    : isSessionRoute(api.route.current)
      ? { name: "session" as const, sessionID: api.route.current.params.sessionID }
      : undefined)
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
          duration: 8_000,
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

            state.lastOriginal = originalPrompt
            state.lastEnhancedInput = enhanced

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
              : `${baseMessage} Original prompt could not be restored because the prompt changed. Please re-enter your prompt manually.`
            api.ui.toast({ variant: "error", title: TOAST_TITLE, message })
          } finally {
            state.enhancing = false
          }
        })()
      }}
    />
  ))
}

function revertEnhancement(
  api: Api,
  state: PluginState,
  signal: AbortSignal,
): void {
  if (!state.lastOriginal) {
    api.ui.toast({ variant: "warning", title: TOAST_TITLE, message: "No enhancement to revert." })
    return
  }

  const target = state.promptTarget
  if (!target) {
    api.ui.toast({ variant: "warning", title: TOAST_TITLE, message: "Revert only works from a prompt." })
    return
  }

  const handle: PromptHandle = {
    target,
    directory: api.state.path.directory,
    ref: state.promptRef,
  }

  if (!isPromptHandleActive(api, state, handle)) {
    api.ui.toast({ variant: "warning", title: TOAST_TITLE, message: "Prompt changed since enhancement." })
    return
  }

  const currentInput = handle.ref?.current.input ?? ""
  if (currentInput !== state.lastEnhancedInput) {
    api.ui.toast({
      variant: "warning",
      title: TOAST_TITLE,
      message: "Prompt was manually changed after enhancement. Revert skipped.",
    })
    return
  }

  void (async () => {
    try {
      const wrote = await restorePrompt(api, state, handle, state.lastOriginal!, signal)
      if (!wrote) {
        api.ui.toast({
          variant: "warning",
          title: TOAST_TITLE,
          message: "Prompt changed while reverting.",
        })
        return
      }

      state.lastOriginal = undefined
      state.lastEnhancedInput = undefined

      api.ui.toast({
        variant: "success",
        title: TOAST_TITLE,
        message: "Reverted to original prompt.",
        duration: 3000,
      })
    } catch (error) {
      if (signal.aborted) return
      const message = error instanceof Error ? error.message : "Revert failed."
      api.ui.toast({ variant: "error", title: TOAST_TITLE, message })
    }
  })()
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
      onSelect: () => {
        openEnhanceDialog(api, options, state, api.lifecycle.signal)
      },
    },
    {
      title: "Revert Enhanced Prompt",
      value: "prompt-enhancer.revert",
      description: "Revert last prompt enhancement (Ctrl+Shift+E)",
      category: "Prompt",
      keybind: "ctrl+shift+e",
      onSelect: () => {
        revertEnhancement(api, state, api.lifecycle.signal)
      },
    },
  ])

  api.lifecycle.onDispose(() => {
    unregister()
    api.ui.dialog.clear()
    state.enhancing = false
    state.promptRef = undefined
    state.promptTarget = undefined
    state.lastOriginal = undefined
    state.lastEnhancedInput = undefined
  })
}

const plugin = {
  id: "prompt-enhancer",
  tui,
} satisfies TuiPluginModule & { id: string }

export default plugin
