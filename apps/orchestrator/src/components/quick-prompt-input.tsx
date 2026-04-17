/**
 * QuickPromptInput — Zero-friction new session creation.
 *
 * Centered prompt input with inline config chips for project and model.
 * Uses the same PromptInput composer as the in-session MessageInput so users
 * can paste, drag, or attach images when kicking off a new session.
 * Appears when no session is selected.
 */

import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@duraclaw/ai-elements'
import { ImageIcon, XIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Checkbox } from '~/components/ui/checkbox'
import { Label } from '~/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { useUserDefaults } from '~/hooks/use-user-defaults'
import type { ContentBlock } from '~/lib/types'
import { useTabStore } from '~/stores/tabs'

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-7', label: 'claude-opus-4-7', agent: 'claude' },
  { value: 'claude-opus-4-6', label: 'claude-opus-4-6', agent: 'claude' },
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', agent: 'claude' },
  { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5', agent: 'claude' },
  { value: 'gpt-5.4', label: 'codex — gpt-5.4', agent: 'codex' },
  { value: 'gpt-5.4-mini', label: 'codex — gpt-5.4-mini', agent: 'codex' },
]

const MAX_IMAGE_SIZE = 5 * 1024 * 1024

interface ImagePreview {
  data: string
  media_type: string
  thumbnail: string
}

export interface QuickPromptInputProps {
  onSubmit: (config: {
    project: string
    model: string
    agent?: string
    prompt: string | ContentBlock[]
    newTab?: boolean
  }) => void
  projects: Array<{ name: string; path: string; repo_origin?: string | null }>
  projectsLoading?: boolean
  /** Optional pre-selected project (e.g. from a tab context-menu action). */
  initialProject?: string
  /** Optional pre-set newTab checkbox state (applies only if selected project has an existing tab). */
  initialNewTab?: boolean
}

function extractRepoName(repoOrigin: string): string {
  const cleaned = repoOrigin.replace(/\.git$/, '')
  const parts = cleaned.split(/[/:]/)
  const name = parts[parts.length - 1] || 'Unknown'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function QuickPromptInput({
  onSubmit,
  projects,
  projectsLoading,
  initialProject,
  initialNewTab,
}: QuickPromptInputProps) {
  const { preferences } = useUserDefaults()

  const [selectedProject, setSelectedProject] = useState(initialProject ?? '')
  const [selectedModel, setSelectedModel] = useState(() => {
    return MODEL_OPTIONS.find((m) => m.value === preferences.model)?.value ?? MODEL_OPTIONS[0].value
  })
  const [newTab, setNewTab] = useState(initialNewTab ?? false)
  const [images, setImages] = useState<ImagePreview[]>([])
  const [imageError, setImageError] = useState<string | null>(null)

  // Check if selected project already has a tab
  const existingTab = useTabStore((s) => s.findTabByProject)(selectedProject)

  // Update model when preferences load
  useEffect(() => {
    if (preferences.model) setSelectedModel(preferences.model)
  }, [preferences.model])

  // Auto-select first project when loaded
  useEffect(() => {
    if (projects.length > 0 && !selectedProject) {
      setSelectedProject(projects[0].name)
    }
  }, [projects, selectedProject])

  // Reset newTab when project changes
  const prevProjectRef = useRef(selectedProject)
  if (prevProjectRef.current !== selectedProject) {
    prevProjectRef.current = selectedProject
    setNewTab(false)
  }

  const currentModel = MODEL_OPTIONS.find((m) => m.value === selectedModel) ?? MODEL_OPTIONS[0]

  const processFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return
    if (file.size > MAX_IMAGE_SIZE) {
      setImageError('Image must be under 5MB')
      return
    }
    setImageError(null)
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
    setImageError(null)
  }, [])

  const handleSubmit = (message: { text?: string }) => {
    const text = message.text?.trim() ?? ''
    if (!text && images.length === 0) return
    if (!selectedProject) return

    let prompt: string | ContentBlock[]
    if (images.length > 0) {
      prompt = [
        ...images.map(
          (img): ContentBlock => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: img.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: img.data,
            },
          }),
        ),
        ...(text ? [{ type: 'text' as const, text }] : []),
      ]
    } else {
      prompt = text
    }

    onSubmit({
      project: selectedProject,
      model: currentModel.value,
      agent: currentModel.agent,
      prompt,
      newTab: existingTab ? newTab : undefined,
    })

    setImages([])
    setImageError(null)
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 h-full px-4">
      <h2 className="text-2xl font-semibold tracking-tight">What should the agent do?</h2>
      <div className="flex items-center gap-2">
        <Select
          value={selectedProject}
          onValueChange={setSelectedProject}
          disabled={projectsLoading || projects.length === 0}
        >
          <SelectTrigger className="h-8 w-auto min-w-32 rounded-full text-xs font-mono">
            <SelectValue placeholder={projectsLoading ? 'Loading...' : 'Project'} />
          </SelectTrigger>
          <SelectContent>
            {(() => {
              const grouped = new Map<string, typeof projects>()
              for (const p of projects) {
                const key = p.repo_origin || 'Other'
                if (!grouped.has(key)) grouped.set(key, [])
                grouped.get(key)?.push(p)
              }
              return Array.from(grouped.entries()).map(([origin, groupProjects]) => (
                <SelectGroup key={origin}>
                  <SelectLabel className="text-[11px] font-medium text-muted-foreground">
                    {extractRepoName(origin)}
                  </SelectLabel>
                  {groupProjects.map((p) => (
                    <SelectItem key={p.name} value={p.name} className="text-xs font-mono">
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))
            })()}
          </SelectContent>
        </Select>
        <Select value={selectedModel} onValueChange={setSelectedModel}>
          <SelectTrigger className="h-8 w-auto min-w-40 rounded-full text-xs font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODEL_OPTIONS.map((m) => (
              <SelectItem key={m.value} value={m.value} className="text-xs font-mono">
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="w-full max-w-lg">
        <PromptInput
          onPaste={handlePaste}
          onSubmit={handleSubmit}
          className="rounded-lg border bg-background shadow-sm"
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
          {imageError && <p className="px-3 pt-1 text-xs text-destructive">{imageError}</p>}
          <PromptInputBody>
            <PromptInputTextarea
              placeholder="Describe the task, paste or attach an image..."
              autoFocus
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
            <PromptInputSubmit disabled={!selectedProject} />
          </PromptInputFooter>
        </PromptInput>
      </div>
      {existingTab && (
        <div className="flex items-center gap-2">
          <Checkbox
            id="new-tab"
            checked={newTab}
            onCheckedChange={(checked) => setNewTab(checked === true)}
          />
          <Label htmlFor="new-tab" className="text-xs text-muted-foreground cursor-pointer">
            Open in new tab (existing tab for {selectedProject})
          </Label>
        </div>
      )}
    </div>
  )
}
