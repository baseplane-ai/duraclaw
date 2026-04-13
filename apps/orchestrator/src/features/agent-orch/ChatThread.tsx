/**
 * ChatThread — Renders the CodingAgent conversation as a chat thread.
 *
 * Transforms raw gateway events (assistant, tool_result, user_message)
 * into a scrollable chat UI using shared ai-elements components.
 */

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
  Message,
  MessageContent,
  MessageResponse,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
  ToolCallItem,
  ToolCallList,
  ToolCallListContent,
  ToolCallListHeader,
} from '@duraclaw/ai-elements'
import { FileIcon, HistoryIcon } from 'lucide-react'
import type { ChatMessage, GateResponse, SessionState } from '~/lib/types'
import { GateResolver } from './GateResolver'
import { StreamingText } from './StreamingText'
import type { ContentBlock } from './use-coding-agent'

interface ChatThreadProps {
  messages: ChatMessage[]
  gate: SessionState['gate']
  status: SessionState['status']
  state: SessionState | null
  onResolveGate: (gateId: string, response: GateResponse) => Promise<unknown>
  readOnly?: boolean
  streamingContent?: string
  onQaResolved?: (question: string, answer: string) => void
  onRewind?: (turnIndex: number) => void
}

export function ChatThread({
  messages,
  gate,
  status,
  state: _state,
  onResolveGate,
  readOnly,
  streamingContent,
  onQaResolved,
  onRewind,
}: ChatThreadProps) {
  return (
    <Conversation className="min-h-0 flex-1">
      <ConversationContent>
        {messages.length === 0 ? (
          <ConversationEmptyState
            title="No messages yet"
            description="The session will appear here as it runs"
          />
        ) : (
          messages.map((msg, turnIndex) => {
            const rewindButton = onRewind ? (
              <button
                key={`rewind-${msg.id}`}
                type="button"
                onClick={() => onRewind(turnIndex)}
                aria-label="Rewind to this turn"
                title="Rewind to this point"
                data-testid={`rewind-turn-${turnIndex}`}
                className="absolute right-2 top-2 flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
              >
                <HistoryIcon className="size-3" />
                <span>Rewind</span>
              </button>
            ) : null

            if (msg.role === 'qa_pair') {
              const qa = safeParseJson(msg.content) as {
                question?: string
                answer?: string
              }
              return (
                <div key={msg.id} className="group relative" data-turn-index={turnIndex}>
                  <div className="space-y-1 rounded-lg border-l-2 border-blue-500/30 bg-blue-500/5 p-3">
                    <p className="text-xs text-muted-foreground">{qa?.question || 'Question'}</p>
                    <p className="text-sm">{qa?.answer || ''}</p>
                  </div>
                  {rewindButton}
                </div>
              )
            }

            if (msg.role === 'user') {
              const userContent = parseUserContent(msg.content)
              return (
                <div key={msg.id} className="group relative" data-turn-index={turnIndex}>
                  <Message from="user">
                    <MessageContent>
                      {userContent.images.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {userContent.images.map((img) => (
                            <img
                              key={img.data.slice(-20)}
                              src={`data:${img.media_type};base64,${img.data}`}
                              alt="User upload"
                              className="max-h-48 max-w-full rounded-md object-contain"
                            />
                          ))}
                        </div>
                      )}
                      {userContent.text}
                    </MessageContent>
                  </Message>
                  {rewindButton}
                </div>
              )
            }

            if (msg.role === 'assistant') {
              const content = safeParseJson(msg.content)
              const blocks = Array.isArray(content) ? content : []
              const textBlocks = blocks.filter(
                (b: unknown) => (b as { type: string }).type === 'text',
              )
              const toolUseBlocks = blocks.filter(
                (b: unknown) => (b as { type: string }).type === 'tool_use',
              )
              const thinkingBlocks = blocks.filter(
                (b: unknown) => (b as { type: string }).type === 'thinking',
              )
              const textContent = textBlocks
                .map((b: unknown) => (b as { text?: string }).text || '')
                .join('\n')
              const thinkingText = thinkingBlocks
                .map(
                  (b: unknown) =>
                    (b as { thinking?: string; text?: string }).thinking ||
                    (b as { text?: string }).text ||
                    '',
                )
                .join('\n')

              const isCurrentTurn = turnIndex === messages.length - 1 && status === 'running'

              return (
                <div key={msg.id} className="group relative" data-turn-index={turnIndex}>
                  <div className="space-y-2">
                    {thinkingText && (
                      <Reasoning isStreaming={isCurrentTurn} defaultOpen={true}>
                        <ReasoningTrigger />
                        <ReasoningContent>{thinkingText}</ReasoningContent>
                      </Reasoning>
                    )}
                    {textContent && (
                      <Message from="assistant">
                        <MessageContent>
                          <MessageResponse>{textContent}</MessageResponse>
                        </MessageContent>
                      </Message>
                    )}
                    {toolUseBlocks.length > 0 && (
                      <ToolCallList defaultOpen={false}>
                        <ToolCallListHeader count={toolUseBlocks.length} />
                        <ToolCallListContent>
                          {toolUseBlocks.map((tool: unknown, i: number) => {
                            const t = tool as {
                              id?: string
                              name?: string
                              input?: unknown
                            }
                            return (
                              <ToolCallItem
                                key={t.id || i}
                                toolName={t.name || 'unknown'}
                                args={t.input}
                                status={isCurrentTurn ? 'running' : 'completed'}
                              />
                            )
                          })}
                        </ToolCallListContent>
                      </ToolCallList>
                    )}
                  </div>
                  {rewindButton}
                </div>
              )
            }

            if (msg.role === 'tool') {
              if (msg.type === 'file_changed') {
                const data = safeParseJson(msg.content) as { path?: string }
                return (
                  <div key={msg.id} className="group relative" data-turn-index={turnIndex}>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <FileIcon className="size-3" />
                      <span>
                        Modified{' '}
                        <code className="rounded bg-muted px-1">{data?.path || 'unknown'}</code>
                      </span>
                    </div>
                    {rewindButton}
                  </div>
                )
              }
              return null
            }

            return null
          })
        )}

        {/* Thinking indicator */}
        {status === 'running' && !streamingContent && (
          <Message from="assistant">
            <MessageContent>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <span className="flex gap-0.5">
                  <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                </span>
                Thinking
              </span>
            </MessageContent>
          </Message>
        )}

        {/* Streaming text for in-progress assistant turn */}
        {streamingContent && (
          <Message from="assistant">
            <MessageContent>
              <StreamingText streamingContent={streamingContent} />
            </MessageContent>
          </Message>
        )}

        {/* Gate inline at end of chat */}
        {!readOnly && gate && status === 'waiting_gate' && (
          <GateResolver gate={gate} onResolve={onResolveGate} onResolved={onQaResolved} />
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}

function safeParseJson(str: string): unknown {
  try {
    return JSON.parse(str)
  } catch {
    return str
  }
}

interface ParsedUserContent {
  text: string
  images: Array<{ media_type: string; data: string }>
}

function parseUserContent(str: string): ParsedUserContent {
  try {
    const parsed = JSON.parse(str)
    if (typeof parsed === 'string') return { text: parsed, images: [] }
    if (Array.isArray(parsed)) {
      const images: ParsedUserContent['images'] = []
      const texts: string[] = []
      for (const block of parsed as ContentBlock[]) {
        if (block.type === 'text') texts.push(block.text)
        else if (block.type === 'image' && block.source) {
          images.push({ media_type: block.source.media_type, data: block.source.data })
        }
      }
      return { text: texts.join('\n'), images }
    }
    return { text: str, images: [] }
  } catch {
    return { text: str, images: [] }
  }
}
