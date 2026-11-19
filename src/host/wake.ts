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

import type { Agent } from '@deepseek-ai/dsh-agent';

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
  /**
   * 宿主的会话控制器（web / 桌面组合里有）。冷会话要走它这条恢复路径：
   * 控制器恢复时会带上预设与模型，裸调 `agents.resume({resumeSessionId})` 不带给，
   * `agent.options.model` 就是空的，人设段里的 `{{model}}` 拼不出来，整轮直接报
   * `prompt variable "{{model}}" has no value`。
   */
  sessionController?: () => SessionControllerLike | undefined;
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

/** 只需要恢复会话这一件事，别把宿主内部类型引进插件。 */
export interface SessionControllerLike {
  resolveAgent(sessionId: string): Promise<unknown>;
}

const DEFAULT_MAX_TURN_MS = 15 * 60 * 1000;

/** 控制器可能直接回 agent，也可能回 `{ agent }` / `{ error }`。 */
function pickAgent(value: unknown): { agent?: LiveAgent; error?: string } {
  if (value === undefined || value === null) return {};
  const direct = asLiveAgent(value as unknown as Agent | undefined);
  if (direct !== undefined) return { agent: direct };
  const bag = value as { agent?: unknown; error?: { message?: unknown } | string };
  const nested = asLiveAgent(bag.agent as unknown as Agent | undefined);
  if (nested !== undefined) return { agent: nested };
  const error = bag.error;
  if (error === undefined) return {};
  return { error: typeof error === 'string' ? error : String(error.message ?? 'unknown error') };
}

export class WakeDriver {
  readonly #deps: WakeDeps;

  constructor(deps: WakeDeps) {
    this.#deps = deps;
  }

  /** Resolve a live agent, resuming the session when it is cold. */
  async #resolve(sessionId: string): Promise<{ agent?: LiveAgent; resumed?: boolean; error?: string }> {
    const live = asLiveAgent(this.#deps.agents.get(sessionId));
    if (live !== undefined) return { agent: live };

    // 优先走宿主的会话控制器：它按会话记录的预设与模型恢复，和界面/QQ 进来的
    // 那一轮是同一套装配。裸 resume 只给了会话 id，模型就丢了。
    const controller = this.#deps.sessionController?.();
    if (controller !== undefined && typeof controller.resolveAgent === 'function') {
      try {
        const resolved = pickAgent(await controller.resolveAgent(sessionId));
        if (resolved.agent !== undefined) return { agent: resolved.agent, resumed: true };
        if (resolved.error !== undefined) return { error: `resume failed: ${resolved.error}` };
      } catch (error) {
        return { error: `resume failed: ${String(error)}` };
      }
    }

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
