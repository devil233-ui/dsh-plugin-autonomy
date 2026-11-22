/**
 * Agent-scoped tools. They are registered on every root agent's scoped
 * context (and again for resumed agents, via `agent/created`), so they are
 * available during an autonomous turn as well as during an ordinary one.
 *
 *   autonomy_schedule  read / set / cancel this session's self-scheduled wake
 *   autonomy_intents   the intent ledger: list, remember, revise, complete, abandon
 *   autonomy_say       speak through the installed aura bot (QQ), target-gated
 *   autonomy_finish    end an autonomous turn: acted or no_action, plus a reason
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool, type ToolCallView } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

/** JSON-safe value, as required by tool result payloads. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

import { createIntent, reviseIntent, settleIntent, isOpen, remindAt, type Intent } from '../core/intent.js';
import { canFinish, settleRun } from '../core/run.js';
import { enqueueOutbox, type OutboxItem } from '../core/outbox.js';
import { interjectionDenied, parseSpeakEvents, speakDenied } from '../core/speak.js';
import type { AutonomyConfig } from './settings.js';
import type { Scheduler } from './scheduler.js';
import { MAX_SEEN_REQUESTS, type SessionState, type StateStore } from './state.js';

export interface ToolServices {
  config(): AutonomyConfig;
  state: StateStore;
  scheduler: Scheduler;
  now(): number;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /**
   * Send one message through the aura bot bridge (`ctx.get('aurabot').send`).
   * Absent when aura is not installed, which is a normal deployment.
   */
  say?(target: string, text: string): Promise<unknown>;
  /**
   * The aura bot's recent events (`ctx.get('aurabot').events`), used only to
   * tell whether a chat is mid-exchange. Absent without aura as well.
   */
  recentEvents?(): Promise<unknown>;
}

function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text' as const, text: JSON.stringify(value) }] as ContentBlock[];
}

function presentCard(title: string, rawInput: string): ToolCallView {
  return { card: 'generic' as const, title, kind: 'other', rawInput };
}

/** Tool results must be plain JSON; this keeps the call sites readable. */
function json(value: unknown): Record<string, JsonValue> {
  return value as Record<string, JsonValue>;
}

function sessionIdOf(agent: Agent): string {
  return String(agent.id);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Parse `YYYY-MM-DDTHH:MM` as local wall-clock time and return an ISO string
 * (what the core validators accept). Returns null when the input is malformed
 * or lands on a nonexistent local time.
 */
function parseLocalDateTime(text: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text.trim());
  if (match === null) return null;
  const [, y, mo, d, h, mi] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0, 0);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

/** Append a requestId to the bounded idempotency ring. */
function rememberRequest(state: SessionState, requestId: string): string[] {
  const seen = [...(state.seenRequests ?? []), requestId];
  return seen.slice(-MAX_SEEN_REQUESTS);
}

function newIntentId(): string {
  return `i${Math.random().toString(16).slice(2, 10)}`;
}

export function autonomyToolDefinitions(agent: Agent, services: ToolServices) {
  const sessionId = sessionIdOf(agent);

  return [
    defineTool({
      name: 'autonomy_schedule',
      description:
        'Read, set, or cancel this session\'s self-scheduled wake. The autonomy plugin already wakes this session on its own rhythm; use this only when you want a specific later moment (for example "check the build in 40 minutes"). action=get shows the current self-wake and the next automatic roll.',
      parameters: {
        action: { type: 'string', required: true, description: 'get | set | cancel' },
        at: { type: 'string', description: 'set only: local wall-clock time formatted YYYY-MM-DDTHH:MM (must be in the future).' },
        in_minutes: { type: 'integer', description: 'set only: alternative to at — wake this many minutes from now.' },
        note: { type: 'string', description: 'set only: one line explaining why; it is carried into the wake prompt.' },
        version: {
          type: 'integer',
          description:
            'set/cancel: the self_wake_version you read with action=get. A stale version is refused instead of overwriting a newer schedule.',
        },
        requestId: {
          type: 'string',
          description:
            'set/cancel: a stable id for this exact operation. Re-sending the same requestId is a no-op, so a retried tool call cannot reschedule.',
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderValue },
      async execute(args) {
        const action = str(args['action']);
        const config = services.config();
        const now = services.now();

        if (action === 'get') {
          const state = services.state.session(sessionId, now);
          return json({
            session_id: sessionId,
            self_wake: state?.selfWake ?? null,
            self_wake_version: state?.selfWakeVersion ?? 0,
            next_automatic_check_at: state?.nextCheckAt ?? null,
            interval_minutes: config.intervalMinutes,
            probability: config.probability,
            mode: config.mode,
            enabled: config.enabled,
            allow_self_wake: config.allowSelfWake,
            timezone: config.timezone === '' ? 'host default' : config.timezone,
            sleep_windows: config.sleepWindows,
            self_wake_during_sleep: config.selfWakeDuringSleep,
          });
        }

        if (action !== 'set' && action !== 'cancel') return json({ error: `unknown action ${action}` });

        // Idempotency first: a retried call must not touch anything.
        const requestId = str(args['requestId']).trim();
        const snapshot = services.state.session(sessionId, now);
        if (requestId !== '' && (snapshot?.seenRequests ?? []).includes(requestId)) {
          return json({
            session_id: sessionId,
            duplicate: true,
            note: 'this requestId was already applied; nothing changed',
            self_wake: snapshot?.selfWake ?? null,
            self_wake_version: snapshot?.selfWakeVersion ?? 0,
          });
        }

        // Optimistic concurrency: a stale version means the model is looking at
        // an older schedule than the one on disk.
        const version = args['version'];
        if (typeof version === 'number' && Number.isFinite(version)) {
          const current = snapshot?.selfWakeVersion ?? 0;
          if (Math.round(version) !== current) {
            return json({
              error: `version mismatch: current ${current}, got ${Math.round(version)}; call action=get and retry`,
            });
          }
        }

        if (action === 'cancel') {
          if (!config.allowSelfWake) {
            return json({ error: 'self-scheduled wakes are disabled by the operator (allowSelfWake=false)' });
          }
          let had = false;
          services.state.update(sessionId, (state) => {
            had = state.selfWake !== undefined;
            delete state.selfWake;
            state.selfWakeVersion = (state.selfWakeVersion ?? 0) + 1;
            if (requestId !== '') state.seenRequests = rememberRequest(state, requestId);
          }, now);
          return json({ session_id: sessionId, cancelled: had });
        }

        if (!config.allowSelfWake) {
          return json({ error: 'self-scheduled wakes are disabled by the operator (allowSelfWake=false)' });
        }

        const at = str(args['at']);
        const inMinutes = args['in_minutes'];
        let atMs: number | undefined;
        if (at !== '') {
          const iso = parseLocalDateTime(at);
          if (iso === null) return json({ error: 'at must look like YYYY-MM-DDTHH:MM' });
          atMs = Date.parse(iso);
        } else if (typeof inMinutes === 'number' && Number.isFinite(inMinutes)) {
          atMs = now + Math.round(inMinutes) * 60_000;
        }
        if (atMs === undefined) return json({ error: 'set requires at or in_minutes' });
        if (atMs <= now) return json({ error: 'the requested moment is not in the future' });

        const note = str(args['note']).trim();
        const entry = { at: atMs, ...(note === '' ? {} : { note }) };
        services.state.update(sessionId, (state) => {
          state.selfWake = entry;
          state.selfWakeVersion = (state.selfWakeVersion ?? 0) + 1;
          if (requestId !== '') state.seenRequests = rememberRequest(state, requestId);
        }, now);
        services.scheduler.ensureScheduled(sessionId, now);
        return json({
          session_id: sessionId,
          self_wake: entry,
          self_wake_version: (services.state.session(sessionId, now)?.selfWakeVersion ?? 0),
        });
      },
      presentCall: (callArgs) => presentCard('Autonomy schedule', str((callArgs as { action?: unknown })['action'])),
    }),

    defineTool({
      name: 'autonomy_intents',
      description:
        'The intent ledger for this session. Record something you intend to do later (a thought, or an agreement you made with the user), revise it, and settle it when it is done or abandoned. Open intents are also rendered into the prompt of every autonomous wake, so this is how the session remembers what it wanted.',
      parameters: {
        action: { type: 'string', required: true, description: 'list | remember | revise | complete | abandon' },
        id: { type: 'string', description: 'revise/complete/abandon: the intent id.' },
        text: { type: 'string', description: 'remember/revise: what you intend to do.' },
        kind: { type: 'string', description: 'remember: thought (your own idea) or agreement (something promised to the user).' },
        due_at: { type: 'string', description: 'agreement requires it: local YYYY-MM-DDTHH:MM.' },
        preferred_at: { type: 'string', description: 'thought only: local YYYY-MM-DDTHH:MM, a soft reminder time.' },
        expected_version: { type: 'integer', description: 'revise/complete/abandon: the version you read from list.' },
        reason: { type: 'string', description: 'complete/abandon: one short sentence.' },
        include_settled: { type: 'boolean', description: 'list: also return done/abandoned entries.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderValue },
      async execute(args) {
        const action = str(args['action']);
        const now = services.now();
        // The ledger belongs to her, not to whichever chat happened to be open:
        // reads span every session — the same set the wake prompt aggregates —
        // and writes land in the wake room when one is configured.
        const ledgerOwner = services.config().wakeSession.trim();
        const home = ledgerOwner === '' ? sessionId : ledgerOwner;
        const owners = new Map<string, string>();
        const seen = new Set<string>();
        const intents: Intent[] = [];
        const collect = (sid: string): void => {
          const entry = services.state.session(sid, now);
          for (const intent of entry?.intents ?? []) {
            if (seen.has(intent.id)) continue;
            seen.add(intent.id);
            owners.set(intent.id, sid);
            intents.push(intent);
          }
        };
        collect(sessionId);
        if (home !== sessionId) collect(home);
        for (const sid of services.state.sessionIds()) {
          if (sid !== sessionId && sid !== home) collect(sid);
        }

        if (action === 'list') {
          const includeSettled = args['include_settled'] === true;
          const rows = intents
            .filter((intent) => includeSettled || isOpen(intent))
            .map((intent) => ({
              id: intent.id,
              text: intent.text,
              kind: intent.kind,
              state: intent.state,
              version: intent.version,
              remind_at: remindAt(intent) ?? null,
              due_at: intent.dueAt ?? null,
              ledger: owners.get(intent.id) === sessionId
                ? 'this session'
                : owners.get(intent.id) === home
                  ? 'wake room'
                  : `other session ${String(owners.get(intent.id) ?? '').slice(-8)}`,
            }));
          return json({ session_id: sessionId, ledger: home, count: rows.length, intents: rows });
        }

        if (action === 'remember') {
          const preferred = str(args['preferred_at']);
          const due = str(args['due_at']);
          let preferredIso: string | undefined;
          if (preferred !== '') {
            const parsedPreferred = parseLocalDateTime(preferred);
            if (parsedPreferred === null) return json({ error: 'preferred_at is malformed' });
            preferredIso = parsedPreferred;
          }
          let dueIso: string | undefined;
          if (due !== '') {
            const parsedDue = parseLocalDateTime(due);
            if (parsedDue === null) return json({ error: 'due_at is malformed' });
            dueIso = parsedDue;
          }

          const created = createIntent(
            {
              text: str(args['text']),
              kind: str(args['kind']) === 'agreement' ? 'agreement' : 'thought',
              source: 'self',
              ...(preferredIso === undefined ? {} : { preferredAt: preferredIso }),
              ...(dueIso === undefined ? {} : { dueAt: dueIso }),
            },
            new Date(now),
            newIntentId,
          );
          if (!created.ok) return json({ error: created.error });
          services.state.update(home, (entry) => {
            entry.intents = [...entry.intents, created.value];
          }, now);
          return json({ session_id: sessionId, ledger: home, intent: created.value });
        }

        const id = str(args['id']);
        const target = intents.find((intent) => intent.id === id);
        if (target === undefined) return json({ error: `no intent with id ${id}` });
        const owner = owners.get(id) ?? home;
        const expectedVersion = typeof args['expected_version'] === 'number' ? args['expected_version'] : -1;

        if (action === 'revise') {
          const text = str(args['text']);
          const preferred = str(args['preferred_at']);
          const due = str(args['due_at']);
          const revised = reviseIntent(
            target,
            {
              ...(text === '' ? {} : { text }),
              ...(preferred === '' ? {} : { preferredAt: parseLocalDateTime(preferred) }),
              ...(due === '' ? {} : { dueAt: parseLocalDateTime(due) }),
            },
            expectedVersion,
            new Date(now),
          );
          if (!revised.ok) return json({ error: revised.error });
          services.state.update(owner, (entry) => {
            entry.intents = entry.intents.map((intent) => (intent.id === id ? revised.value : intent));
          }, now);
          return json({ session_id: sessionId, ledger: owner, intent: revised.value });
        }

        if (action === 'complete' || action === 'abandon') {
          const reason = str(args['reason']).trim();
          const settled = settleIntent(
            target,
            action === 'complete' ? 'done' : 'abandoned',
            expectedVersion,
            reason === '' ? undefined : reason,
            new Date(now),
          );
          if (!settled.ok) return json({ error: settled.error });
          services.state.update(owner, (entry) => {
            entry.intents = entry.intents.map((intent) => (intent.id === id ? settled.value : intent));
          }, now);
          return json({ session_id: sessionId, ledger: owner, intent: settled.value });
        }

        return json({ error: `unknown action ${action}` });
      },
      presentCall: (callArgs) => presentCard('Autonomy intents', str((callArgs as { action?: unknown })['action'])),
    }),

    defineTool({
      name: 'autonomy_say',
      description:
        'Speak through the aura bot (QQ) from an autonomous turn. The owner in private is always reachable by omitting target; other chats must be whitelisted. A chat where someone is waiting for her answer, or the same chat inside the cooldown window, is refused — pass when_free to queue it instead and have it delivered once the chat goes quiet (it expires after outboxTtlMinutes). The aura bot still applies its own rules and reports back what happened. Use it when saying something is worth more than staying silent — most wakes end without it.',
      parameters: {
        target: { type: 'string', required: true, description: 'A whitelisted chat: group:<qq> or private:<qq>. Omit (empty) to message the owner in private.' },
        when_free: {
          type: 'boolean',
          description: 'Queue instead of failing when the chat is busy or inside the cooldown; delivered on a later sweep, expires after outboxTtlMinutes.',
        },
        text: { type: 'string', required: true, description: 'What to say. Aura splits it into bubbles on its own rules.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderValue },
      async execute(args) {
        const text = str(args['text']).trim();
        const target = str(args['target']).trim();
        if (text === '') return json({ error: 'text is empty' });
        const config = services.config();
        const whenFree = args['when_free'] === true;
        // A refusal is not a dead end: with when_free she parks the sentence in
        // the ledger's outbox and a later sweep delivers it once the chat is
        // quiet. It expires, because a reply to a ten-minute-old line is worse
        // than silence.
        const refuse = (reason: string): Record<string, JsonValue> => {
          if (!whenFree) return json({ error: reason });
          const ttlMs = config.outboxTtlMinutes * 60_000;
          if (ttlMs <= 0) return json({ error: `${reason}; queueing is off (outboxTtlMinutes = 0)` });
          const room = config.wakeSession.trim();
          const home = room === '' ? sessionId : room;
          const id = `o${Date.now().toString(16)}${Math.random().toString(16).slice(2, 6)}`;
          let queued: OutboxItem | undefined;
          services.state.update(
            home,
            (state) => {
              state.outbox = enqueueOutbox(state.outbox ?? [], { id, target, text, now: services.now(), ttlMs });
              queued = state.outbox.find((item) => item.id === id);
            },
            services.now(),
          );
          return json({
            queued: queued !== undefined,
            id,
            target: target === '' ? 'owner private' : target,
            expires_in_minutes: config.outboxTtlMinutes,
            why_queued: reason,
          });
        };
        const denied = speakDenied(target, config.speakTargets);
        if (denied !== '') return refuse(denied);
        // Do not cut into a live exchange: re-derived from the bot's own ring
        // buffer, so no extra bookkeeping is kept here.
        if (services.recentEvents !== undefined) {
          const events = parseSpeakEvents(await services.recentEvents());
          const cuttingIn = interjectionDenied(target, events, services.now(), config.speakCooldownMinutes * 60_000);
          if (cuttingIn !== '') return refuse(cuttingIn);
        }
        if (services.say === undefined) return json({ error: 'the aura bot bridge is not available in this host' });
        try {
          const result = await services.say(target, text);
          return json(result);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) });
        }
      },
      presentCall: (callArgs) => presentCard('Say it out loud', str((callArgs as { target?: unknown })['target']) || 'owner'),
    }),

    defineTool({
      name: 'autonomy_finish',
      description:
        'End the current autonomous turn. decision is "acted" if you did something (spoke, changed a file, ran a check) or "no_action" if you deliberately did nothing; reason is one short sentence. Only valid during a scheduled autonomy wake: pass the run_id from the wake prompt. Calling it is optional — an autonomous turn that ends without it is still recorded from what the turn actually did.',
      parameters: {
        run_id: { type: 'string', required: true, description: 'The run id from the autonomy wake prompt.' },
        decision: { type: 'string', required: true, description: 'acted | no_action' },
        reason: { type: 'string', required: true, description: 'One short sentence explaining the decision.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderValue },
      async execute(args) {
        const runId = str(args['run_id']);
        const decision = str(args['decision']);
        const reason = str(args['reason']).trim();
        if (decision !== 'acted' && decision !== 'no_action') {
          return json({ error: 'decision must be acted or no_action' });
        }
        const now = services.now();
        const state = services.state.session(sessionId, now);
        const run = state?.runs.find((entry) => entry.id === runId);
        if (run === undefined) {
          return json({ error: `no run ${runId} for this session; finish only the wake you were started by` });
        }
        // 收尾几乎总是落在 settling：唤醒投递成功那一刻 run 就已经不在 running 了，
        // 这里只拒真正的终态，别把她自己的判断挡在门外。
        if (!canFinish(run.status)) return json({ error: `run ${runId} is already ${run.status}` });

        const settled = settleRun(run, decision, reason === '' ? 'no reason given' : reason, new Date(now));
        services.state.update(sessionId, (entry) => {
          entry.runs = entry.runs.map((row) => (row.id === runId ? settled : row));
        }, now);
        return json({ session_id: sessionId, run_id: runId, decision, reason });
      },
      presentCall: (callArgs) => presentCard('Finish autonomy turn', str((callArgs as { decision?: unknown })['decision'])),
    }),
  ];
}

export function registerAutonomyTools(
  agentCtx: Context,
  agent: Agent,
  services: ToolServices,
): { disposer: () => void } {
  return {
    disposer: agentCtx.effect(() => {
      const definitions = autonomyToolDefinitions(agent, services);
      const disposers = definitions.map((definition) => agentCtx.tools.register(definition));
      return () => {
        for (const disposer of disposers) disposer();
      };
    }, 'dsh-autonomy:tools') as unknown as () => void,
  };
}
