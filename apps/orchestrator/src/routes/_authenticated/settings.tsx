import { createFileRoute } from '@tanstack/react-router'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { NotificationPreferences } from '~/components/notification-preferences'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { RadioGroup, RadioGroupItem } from '~/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { useLayout } from '~/context/layout-provider'
import { useTheme } from '~/context/theme-provider'
import { useSwUpdate } from '~/hooks/use-sw-update'
import { useUserDefaults } from '~/hooks/use-user-defaults'
import { signOut } from '~/lib/auth-client'

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-7', label: 'claude-opus-4-7' },
  { value: 'claude-opus-4-6', label: 'claude-opus-4-6' },
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
  { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5' },
  { value: 'gpt-5.4', label: 'codex — gpt-5.4' },
  { value: 'gpt-5.4-mini', label: 'codex — gpt-5.4-mini' },
]

const PERMISSION_MODES = [
  { value: 'default', label: 'Default', description: 'Ask for permission on risky actions' },
  { value: 'acceptEdits', label: 'Accept Edits', description: 'Auto-accept file edits' },
  {
    value: 'bypassPermissions',
    label: 'Bypass',
    description: 'Skip all permission prompts',
  },
  { value: 'plan', label: 'Plan', description: 'Plan only, no execution' },
  { value: 'dontAsk', label: "Don't Ask", description: 'Never ask questions' },
  { value: 'auto', label: 'Auto', description: 'Fully autonomous mode' },
]

const THINKING_MODES = [
  { value: 'adaptive', label: 'Adaptive' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' },
]

const EFFORT_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'xHigh' },
  { value: 'max', label: 'Max' },
]

export const Route = createFileRoute('/_authenticated/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  return (
    <>
      <Header>
        <h1 className="text-lg font-semibold">Settings</h1>
      </Header>
      <Main>
        <div className="mx-auto max-w-3xl space-y-6">
          <AccountSection />
          <DefaultsSection />
          <NotificationsSection />
          <AppearanceSection />
          <SystemSection />
        </div>
      </Main>
    </>
  )
}

function AccountSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>Manage your account settings.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          onClick={() => {
            signOut().finally(() => {
              window.location.href = '/login'
            })
          }}
        >
          Sign Out
        </Button>
      </CardContent>
    </Card>
  )
}

function DefaultsSection() {
  const { preferences, updatePreferences, loading } = useUserDefaults()

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Defaults</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading preferences...</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Defaults</CardTitle>
        <CardDescription>
          Default values for new sessions. These can be overridden per session.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Permission Mode */}
        <div className="space-y-3">
          <Label className="text-sm font-medium">Permission Mode</Label>
          <RadioGroup
            value={preferences.permission_mode}
            onValueChange={(value) => updatePreferences({ permission_mode: value })}
            className="grid gap-2"
          >
            {PERMISSION_MODES.map((mode) => (
              <div key={mode.value} className="flex items-start gap-2">
                <RadioGroupItem value={mode.value} id={`perm-${mode.value}`} className="mt-0.5" />
                <div className="grid gap-0.5">
                  <Label htmlFor={`perm-${mode.value}`} className="cursor-pointer text-sm">
                    {mode.label}
                  </Label>
                  <p className="text-xs text-muted-foreground">{mode.description}</p>
                </div>
              </div>
            ))}
          </RadioGroup>
        </div>

        {/* Model */}
        <div className="space-y-2">
          <Label htmlFor="default-model">Model</Label>
          <Select
            value={preferences.model}
            onValueChange={(value) => updatePreferences({ model: value })}
          >
            <SelectTrigger id="default-model" className="w-full max-w-xs">
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

        {/* Max Budget */}
        <div className="space-y-2">
          <Label htmlFor="max-budget">Max Budget (USD)</Label>
          <Input
            id="max-budget"
            type="number"
            min={0}
            step={0.5}
            className="w-full max-w-xs"
            placeholder="No limit"
            value={preferences.max_budget ?? ''}
            onChange={(e) => {
              const val = e.target.value
              updatePreferences({
                max_budget: val === '' ? null : Number.parseFloat(val),
              })
            }}
          />
          <p className="text-xs text-muted-foreground">
            Maximum spend per session. Leave empty for no limit.
          </p>
        </div>

        {/* Thinking Mode */}
        <div className="space-y-2">
          <Label htmlFor="thinking-mode">Thinking Mode</Label>
          <Select
            value={preferences.thinking_mode}
            onValueChange={(value) => updatePreferences({ thinking_mode: value })}
          >
            <SelectTrigger id="thinking-mode" className="w-full max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THINKING_MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Effort */}
        <div className="space-y-2">
          <Label htmlFor="effort">Effort</Label>
          <Select
            value={preferences.effort}
            onValueChange={(value) => updatePreferences({ effort: value })}
          >
            <SelectTrigger id="effort" className="w-full max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EFFORT_OPTIONS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  )
}

function NotificationsSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>Configure which events trigger push notifications.</CardDescription>
      </CardHeader>
      <CardContent>
        <NotificationPreferences />
      </CardContent>
    </Card>
  )
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const { variant, setVariant } = useLayout()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Customize the look and feel of the application.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Theme */}
        <div className="space-y-2">
          <Label htmlFor="theme-select">Theme</Label>
          <Select value={theme} onValueChange={setTheme}>
            <SelectTrigger id="theme-select" className="w-full max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Sidebar Variant */}
        <div className="space-y-2">
          <Label htmlFor="sidebar-variant">Sidebar Variant</Label>
          <Select value={variant} onValueChange={setVariant}>
            <SelectTrigger id="sidebar-variant" className="w-full max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inset">Inset</SelectItem>
              <SelectItem value="floating">Floating</SelectItem>
              <SelectItem value="sidebar">Sidebar</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  )
}

function SystemSection() {
  const { updateAvailable, localHash, remoteHash, applyUpdate } = useSwUpdate()
  const matched = localHash && remoteHash && localHash === remoteHash

  return (
    <Card>
      <CardHeader>
        <CardTitle>System</CardTitle>
        <CardDescription>Application version and maintenance.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 rounded-md border p-3 font-mono text-xs">
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Running</span>
            <span>{localHash ?? '...'}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Deployed</span>
            <span>{remoteHash ?? '...'}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Status</span>
            <span className={matched ? 'text-green-500' : updateAvailable ? 'text-amber-500' : ''}>
              {matched ? 'Up to date' : updateAvailable ? 'Update available' : 'Checking...'}
            </span>
          </div>
        </div>
        <Button variant="outline" onClick={() => applyUpdate()}>
          Force Refresh
        </Button>
        <p className="text-xs text-muted-foreground">
          Reload the app with the latest deployed version, clearing cached assets.
        </p>
      </CardContent>
    </Card>
  )
}
