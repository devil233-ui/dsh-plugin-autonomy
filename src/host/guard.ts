/**
 * Installs the quiet-window gate on a live agent.
 *
 * aurabot (and any other plugin that pushes turns) reaches a session through
 * `agent.followup` / `agent.steer`. Wrapping those two entry points is the only
 * place where this plugin can see the incoming message's `source` before the
 * turn starts, so the decision lives here as a thin adapter over the pure
 * rules in `core/quiet.ts`.
 *
 * A guest turn inside the sleep window is NOT dropped. The pushing plugin
 * marks its chat busy and only clears it on `turn/end`; a dropped message
 * never produces one, which leaves the chat stuck forever. Instead the turn is
 * replaced by a short "stay silent, end the turn" notice that still settles
 * normally.
 *
 * The returned restore function is owned by `ctx.effect` in the caller.
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'

import { suppressReason, type IncomingSource } from '../core/quiet.js'
import type { LiveAgent } from './types.js'

export interface QuietReplacement {
  chat?: string
  excerpt: string
}

export interface GuardDeps {
  /** True while the configured sleep window covers the current local time. */
  sleeping(): boolean
  /** The `quietBlockGuest` switch from the live config. */
  blockGuest(): boolean
  /** Records a replaced turn (state + log); sessionId is the managed session. */
  onSuppress(sessionId: string, reason: string, detail: QuietReplacement): void
  /** Builds the stand-in message that keeps the pusher's turn machine happy. */
  buildQuiet(sessionId: string, detail: QuietReplacement): UserMessage
  log(message: string): void
}

interface SourcedMessage {
  readonly source?: IncomingSource
  readonly content?: readonly { readonly type?: string; readonly text?: string }[]
}

const EXCERPT_LIMIT = 80

function excerptOf(message: SourcedMessage | undefined): string {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const text = block.text.replace(/\s+/g, ' ').trim()
    if (text === '') continue
    return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}…` : text
  }
  return ''
}

export function installIncomingGuard(agent: LiveAgent, deps: GuardDeps): () => void {
  const restores: Array<() => void> = []

  const patch = (name: 'followup' | 'steer'): void => {
    const holder = agent as unknown as Record<string, unknown>
    const original = holder[name]
    if (typeof original !== 'function') return

    const guarded = (...args: unknown[]): unknown => {
      const message = args[0] as SourcedMessage | undefined
      const reason = suppressReason({
        source: message?.source,
        sleeping: deps.sleeping(),
        blockGuest: deps.blockGuest(),
      })
      if (reason === null) {
        return (original as (...inner: unknown[]) => unknown).apply(agent, args)
      }
      const detail: QuietReplacement = {
        chat: message?.source?.speaker?.chat,
        excerpt: excerptOf(message),
      }
      deps.onSuppress(String(agent.id), reason, detail)
      deps.log(`${agent.id}: replaced ${name} with a quiet notice — ${reason}`)
      const replacement = deps.buildQuiet(String(agent.id), detail)
      return (original as (...inner: unknown[]) => unknown).apply(agent, [replacement, ...args.slice(1)])
    }

    try {
      holder[name] = guarded
      restores.push(() => {
        holder[name] = original
      })
    } catch (error) {
      deps.log(`could not wrap ${name}: ${String(error)}`)
    }
  }

  patch('followup')
  patch('steer')

  return () => {
    for (const restore of restores) {
      try {
        restore()
      } catch {
        // restoring is best-effort; a host that froze the property stays frozen
      }
    }
  }
}
