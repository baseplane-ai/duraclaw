/**
 * QuickPromptInput — Zero-friction new session creation.
 *
 * Centered prompt input with inline config chips for project, model, and permission mode.
 * Appears when no session is selected.
 */

import { useEffect, useRef, useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { Textarea } from '~/components/ui/textarea'
import { useUserDefaults } from '~/hooks/use-user-defaults'

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

  const [selectedProject, setSelectedProject] = useState('')
  const [selectedModel, setSelectedModel] = useState(() => {
    return MODEL_OPTIONS.find((m) => m.value === preferences.model)?.value ?? MODEL_OPTIONS[0].value
  })
  const [prompt, setPrompt] = useState('')

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

  // Auto-focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const currentModel = MODEL_OPTIONS.find((m) => m.value === selectedModel) ?? MODEL_OPTIONS[0]

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!prompt.trim() || !selectedProject) return
      onSubmit({
        project: selectedProject,
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
        <Select
          value={selectedProject}
          onValueChange={setSelectedProject}
          disabled={projectsLoading || projects.length === 0}
        >
          <SelectTrigger className="h-8 w-auto min-w-32 rounded-full text-xs font-mono">
            <SelectValue placeholder={projectsLoading ? 'Loading...' : 'Project'} />
          </SelectTrigger>
          <SelectContent>
            {projects.map((p) => (
              <SelectItem key={p.name} value={p.name} className="text-xs font-mono">
                {p.name}
              </SelectItem>
            ))}
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
