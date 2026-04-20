// kata prime - Output context injection block

import { loadKataConfig } from '../config/kata-config.js'
import { getCurrentSessionId, getStateFilePath, resolveTemplatePath } from '../session/lookup.js'
import { readState, stateExists } from '../state/reader.js'
import { readFullTemplateContent } from '../yaml/index.js'

/**
 * Parse command line arguments for prime command
 */
function parseArgs(args: string[]): {
  session?: string
  hookJson?: boolean
} {
  const result: { session?: string; hookJson?: boolean } = {}

  for (const arg of args) {
    if (arg.startsWith('--session=')) {
      result.session = arg.slice('--session='.length)
    } else if (arg === '--hook-json') {
      result.hookJson = true
    }
  }

  return result
}

/**
 * Output mode selection help when no mode is active
 * Reads available modes from modes.yaml dynamically
 */
async function buildModeSelectionHelp(): Promise<string> {
  // Load unified kata config
  const config = loadKataConfig()

  // Get all mode names (sorted, non-deprecated)
  const allModes = Object.keys(config.modes)
    .filter((m) => !config.modes[m].deprecated)
    .sort()
    .join(', ')

  // Build table with issue_handling derived from kata.yaml
  const modeTable = Object.entries(config.modes)
    .filter(([_, cfg]) => !cfg.deprecated)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, cfg]) => {
      const issueRequired = cfg.issue_handling === 'required' ? '**Yes**' : 'No'
      return `| \`${name}\` | ${cfg.description || ''} | ${issueRequired} |`
    })
    .join('\n')

  return `# MODE ENTRY IS MANDATORY

**CRITICAL**: Before doing ANY work that modifies code, you MUST enter a mode.

**EXCEPTION**: Simple lookups, questions, and searches do NOT require a mode. Answer directly. Examples: "what's the last issue created", "show me the test file for X", "how does Y work". Only enter a mode when the user wants to DO something (implement, fix, plan, debug, verify).

## Available Modes

${allModes}

## Quick Reference

| Mode | Description | Issue Required? |
|------|-------------|-----------------|
${modeTable}

## Classify User Intent

| User Says | Intent | Action |
|-----------|--------|--------|
| "what's the last ...", "show me ...", "list ..." | LOOKUP | **Answer directly — no mode needed** |
| "how does ...", "what is ...", "explain ..." | QUESTION | **Answer directly — no mode needed** |
| "add X to CLI", "quick change", "small refactor" | SMALL TASK | \`task\` mode |
| "implement issue #123", "build feature from spec" | SPEC WORK | \`implementation\` mode |
| "bug: ...", "fix #456", "broken ..." | BUG FIX | \`debug\` mode |
| "plan ...", "design ...", "spec ..." | PLANNING | \`planning\` mode |
| "research ...", "comprehensive exploration" | RESEARCH | \`research\` mode |
| "investigate ...", "why is ...", "debug ..." | DEBUG | \`debug\` mode |

## Commands

\`\`\`bash
kata enter <mode>                       # Enter a mode
kata enter implementation --issue=123  # Issue-backed from spec
kata link <issue-num>                   # Link session to issue mid-session
kata status                             # Check current mode and phase
kata can-exit                           # Check stop conditions
\`\`\`

**NEVER skip mode entry for work that modifies code.** But simple lookups and questions can be answered directly.`
}

/**
 * Build full context block for prime output
 */
async function buildContextBlock(sessionId: string): Promise<string> {
  const contextParts: string[] = []
  const stateFile = await getStateFilePath(sessionId)

  if (await stateExists(stateFile)) {
    const state = await readState(stateFile)

    // If we have a current mode with a template, output the full template content
    if (state.currentMode && state.currentMode !== 'default' && state.template) {
      try {
        const templatePath = resolveTemplatePath(state.template)
        const templateContent = readFullTemplateContent(templatePath)

        if (templateContent) {
          contextParts.push(`# Active Mode: ${state.currentMode}`)
          if (state.workflowId) {
            contextParts.push(`# Workflow: ${state.workflowId}`)
          }
          if (state.issueNumber) {
            contextParts.push(`# Issue: #${state.issueNumber}`)
          }
          if (state.currentPhase) {
            contextParts.push(`# Current Phase: ${state.currentPhase}`)
          }
          contextParts.push('')
          contextParts.push('---')
          contextParts.push('')
          contextParts.push(templateContent)

          // Ledger context
          if (state.ledger) {
            const ledgerParts: string[] = []
            if (state.ledger.decisions?.length) {
              ledgerParts.push('## Decisions')
              for (const d of state.ledger.decisions) {
                ledgerParts.push(`- ${d}`)
              }
            }
            if (state.ledger.discoveries?.length) {
              ledgerParts.push('## Discoveries')
              for (const d of state.ledger.discoveries) {
                ledgerParts.push(`- ${d}`)
              }
            }
            if (state.ledger.corrections?.length) {
              ledgerParts.push('## Corrections')
              for (const c of state.ledger.corrections) {
                ledgerParts.push(`- ${c}`)
              }
            }
            if (ledgerParts.length > 0) {
              contextParts.push('')
              contextParts.push('---')
              contextParts.push('# Session Ledger')
              contextParts.push(...ledgerParts)
            }
          }

          // Inject global and task rules from kata.yaml
          const { loadKataConfig } = await import('../config/kata-config.js')
          const kataConfig = loadKataConfig()

          const ruleParts: string[] = []
          if (kataConfig.global_rules.length > 0) {
            ruleParts.push('## Global Rules')
            for (const rule of kataConfig.global_rules) {
              ruleParts.push(`- ${rule}`)
            }
          }
          if (kataConfig.task_rules.length > 0 && state.currentPhase) {
            ruleParts.push('## Task System Rules')
            for (const rule of kataConfig.task_rules) {
              ruleParts.push(`- ${rule}`)
            }
          }
          if (ruleParts.length > 0) {
            contextParts.push('')
            contextParts.push(ruleParts.join('\n'))
          }

          return contextParts.join('\n')
        }
      } catch {
        // Template not found, fall through to mode selection help
      }
    }
  }

  // No active mode or no template - show mode selection help
  const modeHelp = await buildModeSelectionHelp()
  return modeHelp
}

/**
 * kata prime [--session=ID] [--hook-json]
 * Outputs context injection block (like bt prime, bpd prime)
 *
 * When --hook-json is passed, outputs valid Claude Code hook JSON:
 * { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '...' } }
 *
 * If in a mode with a template, outputs the FULL template content.
 * Otherwise outputs mode selection help.
 */
export async function prime(args: string[]): Promise<void> {
  const parsed = parseArgs(args)

  try {
    const sessionId = parsed.session || (await getCurrentSessionId())
    const contextBlock = await buildContextBlock(sessionId)

    if (parsed.hookJson) {
      // Output as Claude Code hook JSON
      const output = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: contextBlock,
        },
      }
      process.stdout.write(`${JSON.stringify(output)}\n`)
    } else {
      // Output as plain text

      console.log(contextBlock)
    }
  } catch {
    // No session - show mode selection help
    const modeHelp = await buildModeSelectionHelp()

    if (parsed.hookJson) {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: modeHelp,
        },
      }
      process.stdout.write(`${JSON.stringify(output)}\n`)
    } else {
      console.log(modeHelp)
    }
  }
}
