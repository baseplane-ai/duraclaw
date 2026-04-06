// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToolPart } from './tool-part'

describe('ToolPart', () => {
  it('shows approval details for bash commands', () => {
    render(
      <ToolPart
        input={{
          command: 'echo APPROVAL_CHECK > duraclaw-permission-check-bash.txt',
          file_path: '/data/projects/baseplane/duraclaw-permission-check-bash.txt',
        }}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        state="approval-requested"
        toolCallId="tool-1"
        toolName="Bash"
      />,
    )

    expect(screen.getByText('Approve Bash')).toBeTruthy()
    expect(screen.getByTestId('tool-command').textContent).toContain('echo APPROVAL_CHECK')
    expect(screen.getByTestId('tool-file-path').textContent).toContain(
      'duraclaw-permission-check-bash.txt',
    )
  })
})
