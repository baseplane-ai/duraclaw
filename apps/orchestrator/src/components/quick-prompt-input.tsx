/**
 * QuickPromptInput — Zero-friction new session creation.
 *
 * Centered prompt input with inline config chips for project, model, and permission mode.
 * Appears when no session is selected.
 */

import { useEffect, useRef, useState } from 'react'
import { Button } from '~/components/ui/button'
import { Textarea } from '~/components/ui/textarea'
import { useUserDefaults } from '~/hooks/use-user-defaults'
import { cn } from '~/lib/utils'

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-6', label: 'claude-opus-4-6', agent: 'claude' },
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', agent: 'claude' },
  { value: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5', agent: 'claude' },
  { value: 'gpt-5.4', label: 'codex — gpt-5.4', agent: 'codex' },
  { value: 'gpt-5.4-mini', label: 'codex — gpt-5.4-mini', agent: 'codex' },
]

export interface QuickPromptInputProps {
  onSubmit: (config: { project: string; model: string; agent?: string; prompt: string }) => void
  projects: Array<{ name: string; path: string }>
  projectsLoading?: boolean
}

export function QuickPromptInput({ onSubmit, projects, projectsLoading }: QuickPromptInputProps) {
  const { preferences } = useUserDefaults()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [projectIndex, setProjectIndex] = useState(0)
  const [modelIndex, setModelIndex] = useState(() => {
    const idx = MODEL_OPTIONS.findIndex((m) => m.value === preferences.model)
    return idx >= 0 ? idx : 0
  })
  const [prompt, setPrompt] = useState('')

  // Update model index when preferences load
  useEffect(() => {
    const idx = MODEL_OPTIONS.findIndex((m) => m.value === preferences.model)
    if (idx >= 0) setModelIndex(idx)
  }, [preferences.model])

  // Auto-focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const currentProject = projects[projectIndex]?.name ?? ''
  const currentModel = MODEL_OPTIONS[modelIndex]

  const handleProjectChipClick = () => {
    if (projects.length === 0) return
    setProjectIndex((prev) => (prev + 1) % projects.length)
  }

  const handleModelChipClick = () => {
    setModelIndex((prev) => (prev + 1) % MODEL_OPTIONS.length)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!prompt.trim() || !currentProject) return
      onSubmit({
        project: currentProject,
        model: currentModel.value,
        agent: currentModel.agent,
        prompt: prompt.trim(),
      })
    }
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 h-full">
      <h2 className="text-2xl font-semibold tracking-tight">What should the agent do?</h2>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          type="button"
          className={cn('rounded-full px-3 py-1 text-xs font-mono')}
          onClick={handleProjectChipClick}
          disabled={projectsLoading || projects.length === 0}
        >
          {projectsLoading ? 'Loading...' : currentProject || 'No projects'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          type="button"
          className={cn('rounded-full px-3 py-1 text-xs font-mono')}
          onClick={handleModelChipClick}
        >
          {currentModel.label}
        </Button>
      </div>
      <Textarea
        ref={textareaRef}
        placeholder="Type a prompt and press Enter..."
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={handleKeyDown}
        className="max-w-lg w-full"
        rows={3}
      />
    </div>
  )
}
