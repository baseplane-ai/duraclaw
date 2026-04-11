/**
 * SpawnAgentForm — Form for spawning a new session.
 *
 * Fetches available projects from agent-gateway and collects spawn config.
 * Adapted from baseplane: replaced Picker with Select, removed org_id.
 */

import { useEffect, useState } from 'react'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { Textarea } from '~/components/ui/textarea'

interface Project {
  name: string
  path: string
}

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-6', label: 'claude-opus-4-6', agent: 'claude' },
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', agent: 'claude' },
  { value: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5', agent: 'claude' },
  { value: '', label: 'codex (default)', agent: 'codex' },
  { value: 'gpt-5.4', label: 'codex — gpt-5.4', agent: 'codex' },
  { value: 'gpt-5.4-mini', label: 'codex — gpt-5.4-mini', agent: 'codex' },
]

export interface SpawnFormConfig {
  project: string
  model: string
  agent?: string
  prompt: string
}

interface SpawnAgentFormProps {
  onSpawn: (config: SpawnFormConfig) => void
  disabled?: boolean
  inline?: boolean
}

export function SpawnAgentForm({ onSpawn, disabled, inline }: SpawnAgentFormProps) {
  const [project, setProject] = useState('')
  const [model, setModel] = useState('claude-opus-4-6')
  const [prompt, setPrompt] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch only on mount
  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const resp = await fetch('/api/gateway/projects')
        if (resp.ok) {
          const data = (await resp.json()) as Project[] | { projects?: Project[] }
          const list = Array.isArray(data) ? data : (data.projects ?? [])
          setProjects(list)
          if (list.length > 0 && !project) {
            setProject(list[0].name)
          }
        }
      } catch {
        // Fallback: user can type manually
      } finally {
        setProjectsLoading(false)
      }
    }
    fetchProjects()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!prompt.trim()) return

    const selectedModel = MODEL_OPTIONS.find((m) => m.value === model)
    onSpawn({
      project: project || 'default',
      model,
      agent: selectedModel?.agent,
      prompt: prompt.trim(),
    })
  }

  const formContent = (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Project</Label>
          {projects.length > 0 ? (
            <Select value={project} onValueChange={setProject}>
              <SelectTrigger>
                <SelectValue placeholder={projectsLoading ? 'Loading...' : 'Select project'} />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.name} value={p.name}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder={projectsLoading ? 'Loading projects...' : 'e.g. duraclaw'}
            />
          )}
        </div>
        <div className="space-y-1">
          <Label>Model</Label>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODEL_OPTIONS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="spawn-prompt">Prompt</Label>
        <Textarea
          id="spawn-prompt"
          placeholder="What should the agent do?"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
        />
      </div>
      <Button type="submit" disabled={disabled || !prompt.trim() || !project}>
        Spawn Agent
      </Button>
    </form>
  )

  if (inline) return formContent

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Spawn Coding Agent</CardTitle>
      </CardHeader>
      <CardContent>{formContent}</CardContent>
    </Card>
  )
}
