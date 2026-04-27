# kata-task

Manage kata session tasks via CLI. Use when you need to list, view, or update task status.

## Commands

```bash
kata task list                              # List all tasks for current session
kata task list --json                       # JSON output
kata task get <id>                          # Full detail of one task
kata task update <id> --status=completed    # Mark task as completed
kata task update <id> --status=in_progress  # Mark task as in progress
kata task update <id> --status=pending      # Mark task as pending
```

## When to use

- To check which tasks are pending or in progress
- To mark a task as completed after finishing the work
- To update task status as you progress through implementation phases

## Notes

- Task IDs are integers (1, 2, 3, ...)
- Valid statuses: `pending`, `in_progress`, `completed`
- Changes are automatically synced to the active driver's task view
