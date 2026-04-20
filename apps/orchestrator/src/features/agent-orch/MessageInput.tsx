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
  VoiceInputButton,
} from '@duraclaw/ai-elements'
import { ImageIcon, SquareIcon, XIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type * as Y from 'yjs'
import { CursorOverlay } from '~/components/cursor-overlay'
import { TypingIndicator } from '~/components/typing-indicator'
import { useSessionCollab } from '~/hooks/use-session-collab'
import { useVoiceInputEnabled } from '~/hooks/use-voice-input-enabled'
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
  draftKey,
}: MessageInputProps) {
  const [images, setImages] = useState<ImagePreview[]>([])
  const [error, setError] = useState<string | null>(null)
  const { enabled: voiceEnabled } = useVoiceInputEnabled()

  // Open the collab room for this session. When no sessionId is provided
  // (legacy callers / tests without a session), we fall back to a
  // local-only "standalone" room so the hook's invariants still hold but
  // there's nothing to sync.
  const collab = useSessionCollab({ sessionId: sessionId ?? '__standalone' })
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

  const appendTranscriptToDraft = useCallback(
    (transcript: string) => {
      if (!transcript) return
      if (!collabReady) {
        // Collab not ready — fall back to inserting into the textarea
        // via its native DOM API. Safe no-op if the ref is detached.
        const el = textareaRef.current
        if (!el) return
        const prefix = el.value.length && !el.value.endsWith(' ') ? ' ' : ''
        el.value = `${el.value}${prefix}${transcript}`
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return
      }
      const prefix = ytext.length > 0 && !ytext.toString().endsWith(' ') ? ' ' : ''
      ytext.insert(ytext.length, `${prefix}${transcript}`)
    },
    [collabReady, ytext],
  )

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
          <VoiceInputButton
            enabled={voiceEnabled && !textareaDisabled}
            onFinalTranscript={appendTranscriptToDraft}
            onError={(err) => toast.error(`Voice input: ${err}`)}
          />
          <ComposerActions
            ytext={collabReady ? ytext : null}
            disabled={textareaDisabled}
            status={status}
            onInterrupt={onInterrupt}
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
}

/**
 * Renders the combined send/interrupt button inside the prompt input
 * footer. Must live inside <PromptInputProvider> so it can read the
 * current draft text from the controller.
 *
 * Button swap rules:
 *  - text in draft                  → send button (works even while
 *                                     running, so steering messages still
 *                                     submit)
 *  - no text + session running      → animated interrupt button (red
 *                                     pulsing square — cancels the
 *                                     current turn; session stays alive)
 *  - no text + session idle         → disabled send button
 */
function ComposerActions({ ytext, disabled, status, onInterrupt }: ComposerActionsProps) {
  const controller = usePromptInputController()
  const [yLen, setYLen] = useState<number>(ytext ? ytext.length : 0)

  useEffect(() => {
    if (!ytext) return
    setYLen(ytext.length)
    const update = () => setYLen(ytext.length)
    ytext.observe(update)
    return () => ytext.unobserve(update)
  }, [ytext])

  const controllerText = controller.textInput.value
  const hasText = ytext ? yLen > 0 : controllerText.trim().length > 0

  const isRunning = status === 'running' || status === 'waiting_gate'
  const showInterrupt = isRunning && !hasText && Boolean(onInterrupt)

  // The submit button stays interactive when it's acting as the
  // interrupt button even if the composer is "disabled" (waiting_gate) —
  // users should always be able to cut off a runaway turn.
  const submitDisabled = disabled && !showInterrupt && !hasText

  return (
    <PromptInputSubmit
      disabled={submitDisabled}
      status={showInterrupt ? 'streaming' : undefined}
      onStop={showInterrupt && onInterrupt ? onInterrupt : undefined}
      className={cn(
        showInterrupt &&
          'bg-red-500/90 text-white hover:bg-red-500 animate-pulse shadow-[0_0_0_0_rgba(239,68,68,0.6)]',
      )}
    >
      {showInterrupt ? <SquareIcon className="size-4 fill-current" /> : undefined}
    </PromptInputSubmit>
  )
}
