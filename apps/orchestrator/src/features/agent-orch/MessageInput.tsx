/**
 * MessageInput — Text input with image paste/upload for sending follow-up
 * messages to a running session.
 *
 * Draft state lives in a shared Y.Text on `SessionCollabDO` via
 * `useSessionCollab`. The textarea receives the Y.Text through the
 * `yText` prop on `PromptInputTextarea`; awareness fields (user, typing)
 * drive the `PresenceBar` (above) and `TypingIndicator` (below).
 */

import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputController,
} from '@duraclaw/ai-elements'
import { ImageIcon, SquareIcon, XIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type * as Y from 'yjs'
import { CursorOverlay } from '~/components/cursor-overlay'
import { TypingIndicator } from '~/components/typing-indicator'
import { useSessionCollab } from '~/hooks/use-session-collab'
import type { ContentBlock, SessionStatus } from '~/lib/types'
import { cn } from '~/lib/utils'

interface ImagePreview {
  data: string
  media_type: string
  thumbnail: string
}

type SubmitDraftFn = (
  yText: import('yjs').Text,
) => Promise<{ ok: boolean; error?: string; sent?: boolean }>

interface MessageInputProps {
  /**
   * Legacy path — images + non-collab callers still use `onSend`. When
   * only text is being submitted we prefer `submitDraft` so the draft
   * clears optimistically for every connected peer (and restores on
   * failure). Images are sent through `onSend` because the Y.Text only
   * holds plain text.
   */
  onSend: (content: string | ContentBlock[]) => void
  /**
   * Collaborative submit — snapshots the Y.Text, optimistically clears
   * it, and calls SessionAgent.sendMessage under the hood.
   */
  submitDraft?: SubmitDraftFn
  /**
   * Session id that owns this input. Required to open the collab room
   * for this session's draft.
   */
  sessionId?: string
  disabled?: boolean
  /**
   * Live session status. Drives the combined send/interrupt button: when
   * the agent is running and the draft is empty we swap the send icon for
   * an animated interrupt button; any time the user has typed text we
   * show the send button (so steering works mid-run).
   */
  status?: SessionStatus
  /**
   * Interrupt the current turn. Wired through from
   * useCodingAgent.interrupt. The composer's empty-draft running-state
   * button calls this — we never call SessionDO.stop() from the UI
   * because an interrupt keeps the session alive (no runner respawn, no
   * resume-from-transcript) and works for every steering case users
   * actually hit.
   */
  onInterrupt?: () => void
  /**
   * Force-stop escalation — SIGTERMs the runner via gateway HTTP even
   * when the dial-back WS is dead. The composer exposes this by relabeling
   * the interrupt button to "Force stop" after a 5s stuck-interrupt window
   * (see ComposerActions). Users never reach forceStop directly on the
   * first click.
   */
  onForceStop?: (reason?: string) => void
  /**
   * Optional tab id — kept for parity with the previous per-tab draft
   * API. Drafts now live in the shared Y.Text on SessionCollabDO, so this
   * key only scopes the local `PromptInputProvider` (no DO round-trip).
   */
  draftKey?: string
}

const MAX_IMAGE_SIZE = 5 * 1024 * 1024

export function MessageInput({
  onSend,
  submitDraft,
  sessionId,
  disabled,
  status,
  onInterrupt,
  onForceStop,
  draftKey,
}: MessageInputProps) {
  const [images, setImages] = useState<ImagePreview[]>([])
  const [error, setError] = useState<string | null>(null)

  // Open the collab room. Real sessions key the room by `sessionId`.
  // Draft tabs have no sessionId yet but do have a unique `draftKey`
  // (e.g. `draft:<uuid>`), which keeps each draft in its own isolated
  // room — otherwise every draft across every user would collapse onto
  // one shared `__standalone` DO. The literal fallback stays for legacy
  // callers / tests that pass neither prop.
  const collab = useSessionCollab({ sessionId: sessionId ?? draftKey ?? '__standalone' })
  const {
    doc,
    ytext,
    awareness,
    selfClientId,
    status: collabStatus,
    notifyTyping,
    setCursor,
  } = collab
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const collabActive = Boolean(sessionId)
  const collabReady = collabActive && collabStatus === 'connected'
  const isAuthFailed = collabActive && collabStatus === 'auth-failed'

  const processFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return
    if (file.size > MAX_IMAGE_SIZE) {
      setError('Image must be under 5MB')
      return
    }
    setError(null)
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const [prefix, data] = dataUrl.split(',')
      const mediaType = prefix.match(/data:(.*?);/)?.[1] || 'image/png'
      setImages((prev) => [...prev, { data, media_type: mediaType, thumbnail: dataUrl }])
    }
    reader.readAsDataURL(file)
  }, [])

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = e.clipboardData?.files
      if (!files) return
      for (const file of Array.from(files)) {
        if (file.type.startsWith('image/')) {
          e.preventDefault()
          processFile(file)
        }
      }
    },
    [processFile],
  )

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index))
    setError(null)
  }, [])

  const textareaPlaceholder = disabled ? 'Session is not running' : 'Send a message...'

  const textareaDisabled = Boolean(disabled)

  return (
    <PromptInputProvider key={draftKey ?? '__local'}>
      {isAuthFailed && (
        <div
          className="px-4 py-2 text-xs text-destructive"
          role="alert"
          data-testid="collab-auth-banner"
        >
          Session expired — please reload to reconnect.
        </div>
      )}
      <PromptInput
        onPaste={handlePaste}
        onSubmit={async (message: { text?: string }) => {
          // When images are present we always take the legacy path: Y.Text
          // only holds plain text, so image submits can't round-trip
          // through the shared draft.
          if (images.length > 0) {
            // Prefer the textarea's on-form text when no collab is active;
            // otherwise pull from the Y.Text snapshot.
            const text = collabReady ? ytext.toString().trim() : message.text?.trim()
            const blocks: ContentBlock[] = [
              ...images.map(
                (img): ContentBlock => ({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: img.media_type as
                      | 'image/jpeg'
                      | 'image/png'
                      | 'image/gif'
                      | 'image/webp',
                    data: img.data,
                  },
                }),
              ),
              ...(text ? [{ type: 'text' as const, text }] : []),
            ]
            onSend(blocks)
            // Clear the shared draft after an image-accompanied submit.
            if (collabReady && ytext.length > 0) {
              const doc = ytext.doc
              const clear = () => ytext.delete(0, ytext.length)
              if (doc) doc.transact(clear)
              else clear()
            }
            setImages([])
            setError(null)
            return
          }

          // Plain-text path: prefer collaborative submit so the clear +
          // failure-rollback round-trips through the Y.Doc.
          if (collabReady && submitDraft) {
            const result = await submitDraft(ytext)
            if (!result.ok) {
              toast.error('Failed to send — draft restored')
            }
            setError(null)
            return
          }

          // Fallback for non-collab callers (shouldn't happen in the
          // normal flow, but tests and legacy call sites still use onSend).
          const text = message.text?.trim()
          if (text) {
            onSend(text)
          }
          setError(null)
        }}
        className="w-full border-t px-4"
      >
        {images.length > 0 && (
          <div className="flex gap-2 px-3 pt-2">
            {images.map((img, i) => (
              <div
                key={img.thumbnail.slice(-20)}
                className="group relative"
                data-testid="image-preview-chip"
              >
                <img
                  src={img.thumbnail}
                  alt="Preview"
                  className="size-12 rounded border object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeImage(i)}
                  aria-label="Remove image"
                  className="absolute -right-1 -top-1 rounded-full bg-destructive p-0.5 text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {error && <p className="px-3 pt-1 text-xs text-destructive">{error}</p>}
        <PromptInputBody>
          <PromptInputTextarea
            ref={textareaRef}
            placeholder={textareaPlaceholder}
            disabled={textareaDisabled}
            yText={collabReady ? ytext : undefined}
            onInput={collabReady ? notifyTyping : undefined}
            onCursorChange={collabReady ? setCursor : undefined}
          />
          {collabReady && awareness && selfClientId !== null && (
            <CursorOverlay
              awareness={awareness}
              selfClientId={selfClientId}
              textareaRef={textareaRef}
              doc={doc}
              ytext={ytext}
            />
          )}
        </PromptInputBody>
        <PromptInputFooter>
          <label
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Attach image"
          >
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) processFile(file)
                e.target.value = ''
              }}
            />
            <ImageIcon className="size-4" />
          </label>
          <ComposerActions
            ytext={collabReady ? ytext : null}
            disabled={textareaDisabled}
            status={status}
            onInterrupt={onInterrupt}
            onForceStop={onForceStop}
          />
        </PromptInputFooter>
      </PromptInput>
      {collabReady && awareness && selfClientId !== null && (
        <TypingIndicator awareness={awareness} selfClientId={selfClientId} />
      )}
    </PromptInputProvider>
  )
}

interface ComposerActionsProps {
  ytext: Y.Text | null
  disabled: boolean
  status?: SessionStatus
  onInterrupt?: () => void
  onForceStop?: (reason?: string) => void
}

/**
 * Window (ms) after the user's first interrupt click before the button
 * relabels to "Force stop". 3s is long enough that a normal
 * `interrupt` → `result` round trip completes (including a slow tool
 * unwind), short enough that a genuinely wedged session doesn't feel
 * unrescuable. Exported for testability.
 */
export const FORCE_STOP_RELABEL_MS = 3_000

/**
 * Grace period (ms) after the session stops running before the stop
 * button disappears. Keeps the "Stopping..." indicator visible so the
 * user knows the interrupt landed, even if the runner flushes a few
 * more buffered events before dying.
 */
export const STOPPING_GRACE_MS = 3_000

/**
 * Renders the combined send/interrupt button inside the prompt input
 * footer. Must live inside <PromptInputProvider> so it can read the
 * current draft text from the controller.
 *
 * Button states:
 *  - text in draft                       → send button (works even while
 *                                          running, so steering messages
 *                                          still submit)
 *  - no text + idle                      → disabled send button
 *  - no text + running (pre-interrupt)   → animated interrupt button (red
 *                                          pulsing square, cooperative
 *                                          cancel — session stays alive)
 *  - no text + running + interrupted for
 *    > FORCE_STOP_RELABEL_MS              → "Force stop" variant (solid,
 *                                          non-pulsing, tooltip explains
 *                                          the escalation). Click fires
 *                                          onForceStop — SIGTERMs the
 *                                          runner via gateway HTTP.
 *
 * The escalation timer resets when status leaves the busy set (the
 * session successfully interrupted), so a normal interrupt never exposes
 * the force-stop button.
 */
function ComposerActions({
  ytext,
  disabled,
  status,
  onInterrupt,
  onForceStop,
}: ComposerActionsProps) {
  const controller = usePromptInputController()
  // Perf: track only the 0↔non-empty transition of the shared draft, not
  // its full length. `ytext.observe` fires on every keystroke; setting a
  // numeric `yLen` would cause ComposerActions to re-render on every
  // character. The only consumer of the draft-length signal here is the
  // Submit button's `hasText` check, so a boolean that only changes on
  // emptiness transitions is strictly sufficient and re-renders ~0
  // times mid-typing.
  const [isDraftEmpty, setIsDraftEmpty] = useState<boolean>(ytext ? ytext.length === 0 : true)
  const [interruptSentAt, setInterruptSentAt] = useState<number | null>(null)
  const [stoppingGrace, setStoppingGrace] = useState(false)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!ytext) return
    setIsDraftEmpty(ytext.length === 0)
    const update = () => {
      // Functional setState + the React bail-out on reference equality
      // means this is a no-op for the vast majority of keystrokes (any
      // that don't cross the emptiness boundary).
      const next = ytext.length === 0
      setIsDraftEmpty((prev) => (prev === next ? prev : next))
    }
    ytext.observe(update)
    return () => ytext.unobserve(update)
  }, [ytext])

  const isRunning = status === 'running' || status === 'waiting_gate'

  // Status left the busy set → enter a stopping grace period so the
  // button stays visible while the runner flushes buffered events,
  // then clear after STOPPING_GRACE_MS.
  useEffect(() => {
    if (!isRunning && interruptSentAt !== null) {
      setStoppingGrace(true)
      const t = setTimeout(() => {
        setInterruptSentAt(null)
        setStoppingGrace(false)
      }, STOPPING_GRACE_MS)
      return () => clearTimeout(t)
    }
  }, [isRunning, interruptSentAt])

  // While an interrupt is pending, tick once at the relabel threshold so
  // the button visibly flips without waiting for another unrelated
  // render. Single timer, cleaned up on unmount / state change.
  useEffect(() => {
    if (interruptSentAt === null) return
    const elapsed = Date.now() - interruptSentAt
    const remaining = FORCE_STOP_RELABEL_MS - elapsed
    if (remaining <= 0) return
    const t = setTimeout(() => setTick((n) => n + 1), remaining)
    return () => clearTimeout(t)
  }, [interruptSentAt])

  const controllerText = controller.textInput.value
  const hasText = ytext ? !isDraftEmpty : controllerText.trim().length > 0
  const isStoppingGrace = stoppingGrace && interruptSentAt !== null && !isRunning
  const showInterrupt = (isRunning || isStoppingGrace) && !hasText && Boolean(onInterrupt)

  const showForceStop =
    showInterrupt &&
    interruptSentAt !== null &&
    Date.now() - interruptSentAt >= FORCE_STOP_RELABEL_MS &&
    Boolean(onForceStop)

  // The submit button stays interactive when it's acting as the
  // interrupt button even if the composer is "disabled" (waiting_gate) —
  // users should always be able to cut off a runaway turn.
  const submitDisabled = (disabled && !showInterrupt && !hasText) || isStoppingGrace

  const handleStop = () => {
    if (showForceStop && onForceStop) {
      onForceStop('user force-stop from composer')
      setInterruptSentAt(null)
      return
    }
    if (onInterrupt) {
      onInterrupt()
      setInterruptSentAt(Date.now())
    }
  }

  return (
    <PromptInputSubmit
      disabled={submitDisabled}
      status={showInterrupt ? 'streaming' : undefined}
      onStop={showInterrupt ? handleStop : undefined}
      title={
        isStoppingGrace
          ? 'Stopping\u2026'
          : showForceStop
            ? 'Force stop — the interrupt didn\u2019t land. This SIGTERMs the runner process.'
            : showInterrupt
              ? 'Interrupt current turn'
              : undefined
      }
      data-force-stop={showForceStop ? 'true' : undefined}
      className={cn(
        isStoppingGrace && 'bg-red-400/60 text-white cursor-not-allowed opacity-70',
        showInterrupt &&
          !showForceStop &&
          !isStoppingGrace &&
          'bg-red-500/90 text-white hover:bg-red-500 animate-pulse shadow-[0_0_0_0_rgba(239,68,68,0.6)]',
        showForceStop &&
          !isStoppingGrace &&
          'bg-red-700 text-white hover:bg-red-800 ring-2 ring-red-300 ring-offset-1 shadow-lg',
      )}
    >
      {showInterrupt ? <SquareIcon className="size-4 fill-current" /> : undefined}
    </PromptInputSubmit>
  )
}
