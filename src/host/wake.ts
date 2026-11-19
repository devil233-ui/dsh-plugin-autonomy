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
import { sessionLogOf, type AgentsFacade, type LiveAgent } from './types.js';

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
  /** Scored intents for this moment, already filtered and capped by the caller. */
  candidates?: readonly { text: string; kind: string; score: number; why: string }[];
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
  /** Where autonomy_say may send this turn; read fresh so a panel edit applies at once. */
  speakTargets?: () => readonly string[];
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

/**
 * Does this object actually carry the live agent surface?
 *
 * `agents.get` / `resolveAgent` are loosely typed, so a blind cast would happily
 * accept `{ agent }`, `{ error }` or a resume handle as if it were an agent; the
 * first thing we do with it is read `.session.seq`, which then throws inside an
 * async wake and takes the whole host down under DSH's fail-loud policy.
 */
function looksLikeAgent(value: unknown): value is LiveAgent {
  if (value === undefined || value === null || typeof value !== 'object') return false;
  const probe = value as Partial<LiveAgent>;
  const session = probe.session as { seq?: unknown } | undefined;
  return (
    typeof probe.followup === 'function' &&
    session !== undefined &&
    session !== null &&
    typeof session.seq === 'number'
  );
}

/** 控制器可能直接回 agent，也可能回 `{ agent }` / `{ error }` / resume 句柄。 */
function pickAgent(value: unknown): { agent?: LiveAgent; error?: string } {
  if (looksLikeAgent(value)) return { agent: value };
  if (value === undefined || value === null || typeof value !== 'object') return {};
  const bag = value as { agent?: unknown; error?: { message?: unknown } | string };
  if (looksLikeAgent(bag.agent)) return { agent: bag.agent };
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
    const live = this.#deps.agents.get(sessionId);
    if (looksLikeAgent(live)) return { agent: live };

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
      if (looksLikeAgent(handle)) return { agent: handle, resumed: true };
      const resumed = pickAgent(handle);
      if (resumed.agent !== undefined) return { agent: resumed.agent, resumed: true };
      return { error: resumed.error ?? 'resume returned no agent' };
    } catch (error) {
      return { error: `resume failed: ${String(error)}` };
    }
  }

  /**
   * Never throws: an unhandled rejection inside a wake takes the whole host down
   * (DSH exits on uncaught exceptions), and a failed wake is a recorded outcome,
   * not a crash.
   */
  async wake(request: WakeRequest): Promise<WakeOutcome> {
    try {
      return await this.#wake(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#deps.logger.warn(`wake ${request.runId} threw: ${message}`);
      return { status: 'error', sessionId: request.sessionId, error: `wake threw: ${message}` };
    }
  }

  async #wake(request: WakeRequest): Promise<WakeOutcome> {
    const resolved = await this.#resolve(request.sessionId);
    if (resolved.agent === undefined) {
      return {
        status: resolved.error === undefined ? 'unavailable' : 'error',
        sessionId: request.sessionId,
        ...(resolved.error === undefined ? {} : { error: resolved.error }),
      };
    }
    const agent = resolved.agent;
    if (agent.session === undefined || agent.session === null) {
      return { status: 'error', sessionId: request.sessionId, error: 'resolved agent has no session log' };
    }
    const startIndex = agent.session.seq;
    const message = createFramingMessage({
      runId: request.runId,
      sessionId: request.sessionId,
      trigger: request.trigger,
      now: new Date(),
      ...(request.note === undefined ? {} : { note: request.note }),
      openIntents: request.openIntents,
      ...(request.candidates === undefined ? {} : { candidates: request.candidates }),
      timeZone: this.#deps.timeZone,
      speakTargets: this.#deps.speakTargets?.() ?? [],
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
