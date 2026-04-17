/**
 * MessageInput — Text input with image paste/upload for sending follow-up
 * messages to a running session.
 */

import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@duraclaw/ai-elements'
import { ImageIcon, XIcon } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { ContentBlock } from '~/lib/types'

interface ImagePreview {
  data: string
  media_type: string
  thumbnail: string
}

interface MessageInputProps {
  onSend: (content: string | ContentBlock[]) => void
  disabled?: boolean
  /**
   * Optional tab id — kept for parity with the previous per-tab draft
   * API. Drafts now live in the shared Y.Text on SessionCollabDO, so this
   * key only scopes the local `PromptInputProvider` (no DO round-trip).
   */
  draftKey?: string
}

const MAX_IMAGE_SIZE = 5 * 1024 * 1024

export function MessageInput({ onSend, disabled, draftKey }: MessageInputProps) {
  const [images, setImages] = useState<ImagePreview[]>([])
  const [error, setError] = useState<string | null>(null)

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

  return (
    <PromptInputProvider key={draftKey ?? '__local'}>
      <PromptInput
        onPaste={handlePaste}
        onSubmit={(message: { text?: string }) => {
          const text = message.text?.trim()
          if (!text && images.length === 0) return

          if (images.length > 0) {
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
          } else if (text) {
            onSend(text)
          }
          setImages([])
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
            placeholder={disabled ? 'Session is not running' : 'Send a message...'}
            disabled={disabled}
          />
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
          <PromptInputSubmit disabled={disabled} />
        </PromptInputFooter>
      </PromptInput>
    </PromptInputProvider>
  )
}
