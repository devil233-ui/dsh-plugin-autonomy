/**
 * Installs the quiet-window gate on a live agent.
 *
 * aurabot (and any other plugin that pushes turns) reaches a session through
 * `agent.followup` / `agent.steer`. Wrapping those two entry points is the only
 * place where the plugin can see the incoming message's `source` before the
 * turn starts, so the decision lives here as a thin adapter over the pure
 * rules in `core/quiet.ts`.
 *
 * The wrapper is deliberately conservative: anything it cannot prove is a
 * guest aurabot turn is delivered unchanged. `ctx.effect` in the caller owns
 * the returned restore function.
 */

import { suppressReason, type IncomingSource } from '../core/quiet.js'
import type { LiveAgent } from './types.js'

export interface GuardDeps {
  /** True while the configured sleep window covers the current local time. */
  sleeping(): boolean
  /** The `quietBlockGuest` switch from the live config. */
  blockGuest(): boolean
  /** Records a dropped turn (state + log); sessionId is the managed session. */
  onSuppress(sessionId: string, reason: string): void
  log(message: string): void
}

interface SourcedMessage {
  readonly source?: IncomingSource
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
      if (reason !== null) {
        deps.onSuppress(String(agent.id), reason)
        deps.log(`${agent.id}: dropped ${name} — ${reason}`)
        return undefined
      }
      return (original as (...inner: unknown[]) => unknown).apply(agent, args)
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
