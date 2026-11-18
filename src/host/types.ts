/**
 * Runtime-facing shapes this plugin needs from the DSH host.
 *
 * The public `Agent` interface only promises an id; the live capabilities
 * (session log, followup, maintenance claim, idle wait) are added by the
 * agent runtime. They are declared here as a narrow facade so the plugin
 * compiles against the published types without importing host internals.
 */

import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';

/** The live session log surface, across host lines (`.events` or `snapshotEvents()`). */
export interface LiveSession {
  readonly id: string;
  readonly seq: number;
  readonly events?: readonly unknown[];
  snapshotEvents?(): readonly unknown[];
}

/** One live agent with the capabilities this plugin drives. */
export interface LiveAgent {
  readonly id: string;
  readonly session: LiveSession;
  followup(message: UserMessage): void;
  runMaintenance<T>(task: () => Promise<T>): Promise<T>;
  whenIdle(): Promise<void>;
}

export interface AgentHandleLike {
  agent: LiveAgent;
  dispose(): Promise<void>;
}

/** Narrow view of `ctx.agents`. */
export interface AgentsFacade {
  get(sessionId: string): Agent | undefined;
  resume(options: { resumeSessionId: string; signal?: AbortSignal }): Promise<AgentHandleLike>;
  roots(): Agent[];
}

/** Read the session log through whichever surface the host exposes. */
export function sessionLogOf(session: unknown): readonly unknown[] {
  const probe = session as { events?: readonly unknown[]; snapshotEvents?: () => readonly unknown[] };
  if (Array.isArray(probe.events)) return probe.events;
  if (typeof probe.snapshotEvents === 'function') return probe.snapshotEvents();
  return [];
}

/** Cast a registry agent to the live capability surface. */
export function asLiveAgent(agent: Agent | undefined): LiveAgent | undefined {
  return agent === undefined ? undefined : (agent as LiveAgent);
}
