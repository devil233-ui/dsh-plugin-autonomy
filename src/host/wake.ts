/**
 * Wake one session: reuse the live agent when it is running, resume it when
 * it is cold, deliver the framing message, and wait for the turn to settle.
 *
 * Two properties matter more than anything else here:
 *   - the message is delivered through `runMaintenance`, so an agent that is
 *     mid-turn is never interrupted (a rejected claim means "busy, try later"
 *     rather than "lost wake");
 *   - the turn's outcome is read off the committed log afterwards, not from
 *     the model's own claim, so a silent turn is recorded as silent.
 */

import { createFramingMessage, type WakeTrigger } from './framing.js';
import { observeTurn, type TurnObservation } from './observer.js';
import { asLiveAgent, sessionLogOf, type AgentsFacade, type LiveAgent } from './types.js';

export type WakeStatus = 'ok' | 'busy' | 'unavailable' | 'error';

export interface WakeOutcome {
  status: WakeStatus;
  sessionId: string;
  observation?: TurnObservation;
  error?: string;
}

export interface WakeRequest {
  sessionId: string;
  runId: string;
  trigger: WakeTrigger;
  note?: string;
  openIntents: readonly { text: string; kind: string; dueAt?: string; overdue?: boolean }[];
  /** Config override for the "decide what to do" paragraph. */
  motivation?: string;
}

export interface WakeDeps {
  agents: AgentsFacade;
  timeZone: string;
  /** Upper bound on one autonomous turn before the plugin stops waiting. */
  maxTurnMs?: number;
  /**
   * Called once the turn has been claimed and the plugin starts waiting for it
   * to settle, so the run can be marked `settling` while its verdict is still
   * unknown. A restart in this window must not replay the turn.
   */
  onPhase?: (sessionId: string, runId: string, phase: "settling") => void;
  logger: { warn(message: string): void; error?(message: string): void };
}

const DEFAULT_MAX_TURN_MS = 15 * 60 * 1000;

export class WakeDriver {
  readonly #deps: WakeDeps;

  constructor(deps: WakeDeps) {
    this.#deps = deps;
  }

  /** Resolve a live agent, resuming the session when it is cold. */
  async #resolve(sessionId: string): Promise<{ agent?: LiveAgent; resumed?: boolean; error?: string }> {
    const live = asLiveAgent(this.#deps.agents.get(sessionId));
    if (live !== undefined) return { agent: live };

    if (typeof this.#deps.agents.resume !== 'function') {
      return { error: 'agents.resume is unavailable on this host' };
    }
    try {
      const handle = await this.#deps.agents.resume({ resumeSessionId: sessionId });
      return { agent: handle.agent, resumed: true };
    } catch (error) {
      return { error: `resume failed: ${String(error)}` };
    }
  }

  async wake(request: WakeRequest): Promise<WakeOutcome> {
    const resolved = await this.#resolve(request.sessionId);
    if (resolved.agent === undefined) {
      return {
        status: resolved.error === undefined ? 'unavailable' : 'error',
        sessionId: request.sessionId,
        ...(resolved.error === undefined ? {} : { error: resolved.error }),
      };
    }
    const agent = resolved.agent;
    const startIndex = agent.session.seq;
    const message = createFramingMessage({
      runId: request.runId,
      sessionId: request.sessionId,
      trigger: request.trigger,
      now: new Date(),
      ...(request.note === undefined ? {} : { note: request.note }),
      openIntents: request.openIntents,
      timeZone: this.#deps.timeZone,
      ...(request.motivation === undefined || request.motivation.trim() === ""
        ? {}
        : { motivation: request.motivation }),
    });

    let claimed = false;
    try {
      claimed = await agent.runMaintenance(() => {
        agent.followup(message);
        return Promise.resolve(true);
      });
    } catch (error) {
      // A rejected claim is the documented "agent is busy" signal; anything
      // else is a real fault and gets reported as such.
      const text = String(error);
      return {
        status: text.includes('busy') || text.includes('maintenance') ? 'busy' : 'error',
        sessionId: request.sessionId,
        error: text,
      };
    }
    if (!claimed) return { status: 'busy', sessionId: request.sessionId };

    this.#deps.onPhase?.(request.sessionId, request.runId, 'settling');

    const maxTurnMs = this.#deps.maxTurnMs ?? DEFAULT_MAX_TURN_MS;
    let timedOut = false;
    await Promise.race([
      agent.whenIdle(),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, maxTurnMs).unref?.();
      }),
    ]);
    if (timedOut) {
      this.#deps.logger.warn(
        `dsh-autonomy: session ${request.sessionId} did not settle within ${Math.round(maxTurnMs / 60000)} min; recording observation as-is`,
      );
    }

    const observation = observeTurn(sessionLogOf(agent.session), startIndex);
    return { status: 'ok', sessionId: request.sessionId, observation };
  }
}
