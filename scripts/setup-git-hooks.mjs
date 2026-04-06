import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const hooksPath = '.git-hooks'
const preCommitHook = path.join(repoRoot, hooksPath, 'pre-commit')

if (!existsSync(preCommitHook)) {
  console.log(`Skipping git hook install: missing ${hooksPath}/pre-commit`)
  process.exit(0)
}

chmodSync(preCommitHook, 0o755)

try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: repoRoot,
    stdio: 'ignore',
  })
} catch {
  console.log('Skipping git hook install: not inside a git worktree')
  process.exit(0)
}

let currentHooksPath = ''

try {
  currentHooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
} catch {
  currentHooksPath = ''
}

if (currentHooksPath === hooksPath) {
  console.log(`Git hooks already configured at ${hooksPath}`)
  process.exit(0)
}

execFileSync('git', ['config', 'core.hooksPath', hooksPath], {
  cwd: repoRoot,
  stdio: 'ignore',
})

console.log(`Configured git hooks path: ${hooksPath}`)
