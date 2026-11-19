/**
 * Host half of the panel: one snapshot GET, one closed action POST, one SSE
 * change stream. Same shape as the AstrBot page API (state / configure / wake /
 * stop / self-cancel) plus the two intent mutations the ledger needs.
 *
 * The webserver service is looked up loosely: a headless host composes no
 * webserver, and the plugin must still work there (tools + scheduler only).
 */

import type { Context } from '@deepseek-ai/cordis';

import type { OutboxItem } from '../core/outbox.js';
import { formatLocalStamp } from '../core/schedule.js';
import { createIntent, isOpen, settleIntent, type Intent } from '../core/intent.js';
import { fingerprint } from '../core/score.js';
import type { RunRecord } from '../core/run.js';
import { normalizeConfig, saveConfig, type AutonomyConfig } from './settings.js';
import type { Scheduler } from './scheduler.js';
import type { StateStore } from './state.js';

interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: HttpRequestLike, res: HttpResponseLike) => void }): () => void;
}

interface HttpRequestLike {
  method?: string;
  url?: string;
  on(event: 'data' | 'end' | 'close' | 'error', listener: (chunk?: unknown) => void): void;
}

interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  write(chunk: string): void;
  end(chunk?: string): void;
  writableEnded?: boolean;
}

export interface IntentRow {
  id: string;
  /** Session that actually holds this row; differs from the displayed one when aggregated. */
  ownerSessionId?: string;
  text: string;
  kind: string;
  state: string;
  version: number;
  dueAt?: string;
  preferredAt?: string;
  reason?: string;
  createdAt: string;
}

export interface SessionRow {
  sessionId: string;
  live: boolean;
  supervised: boolean;
  lastActivityAt: number;
  nextCheckAt: number;
  selfWake: { at: number; note?: string } | null;
  /** Last self-scheduled wake that actually fired, for "she planned this" history. */
  lastSelfWake: { at: number; note?: string; firedAt: number } | null;
  openIntents: IntentRow[];
  settledIntents: IntentRow[];
  runs: RunRecord[];
}

export interface PanelSnapshot {
  now: number;
  timeZone: string;
  dataDir: string;
  config: AutonomyConfig;
  sessions: SessionRow[];
  /** Every recorded judgement since local midnight, newest first, across sessions. */
  todayRuns: RunRecord[];
  /** 排队等她说话的消息（新的在前，含刚发出/作废的几条，便于回看）。 */
  outbox: OutboxItem[];
}

/** Filters the standalone page sends; every field is optional. */
export interface RunsQuery {
  limit?: number;
  offset?: number;
  trigger?: string;
  /** `decision` for finished runs, `status` for the ones that never decided. */
  outcome?: string;
  session?: string;
  q?: string;
}

export interface RunsPage {
  total: number;
  offset: number;
  limit: number;
  rows: RunRecord[];
  /** Counts over the query's non-paging filters, for the filter chips. */
  outcomes: Record<string, number>;
  triggers: Record<string, number>;
}

export type PanelAction =
  | { type: 'configure'; patch: Record<string, unknown> }
  | { type: 'create-wake-session' }
  | { type: 'wake'; sessionId?: string }
  | { type: 'stop'; sessionId?: string }
  | { type: 'cancel-self'; sessionId?: string }
  | { type: 'intent-create'; sessionId?: string; text: string; kind?: string; dueAt?: string; preferredAt?: string }
  | { type: 'intent-settle'; sessionId?: string; id: string; state: 'done' | 'abandoned'; version: number; reason?: string };

const BODY_MAX_BYTES = 64 * 1024;
const HEARTBEAT_MS = 25_000;

function toRow(intent: Intent, ownerSessionId?: string): IntentRow {
  return {
    id: intent.id,
    ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
    text: intent.text,
    kind: intent.kind,
    state: intent.state,
    version: intent.version,
    ...(intent.dueAt === undefined ? {} : { dueAt: intent.dueAt }),
    ...(intent.preferredAt === undefined ? {} : { preferredAt: intent.preferredAt }),
    ...(intent.reason === undefined ? {} : { reason: intent.reason }),
    createdAt: intent.createdAt,
  };
}

/** `YYYY-MM-DD` of one instant in the configured zone; empty zone means host zone. */
function dayKey(ms: number, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone === '' ? {} : { timeZone }),
  };
  return new Intl.DateTimeFormat('en-CA', options).format(new Date(ms));
}

function writeJson(res: HttpResponseLike, status: number, body: unknown): void {  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBoundedJson(req: HttpRequestLike, limit: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let text = '';
    req.on('data', (chunk) => {
      const piece = typeof chunk === 'string' ? chunk : String(chunk ?? '');
      size += piece.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        return;
      }
      text += piece;
    });
    req.on('end', () => {
      if (text.trim() === '') {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        resolve(parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on('error', (error) => reject(error instanceof Error ? error : new Error(String(error))));
  });
}

export interface PanelServiceDeps {
  dataDir: string;
  timeZone: string | (() => string);
  getConfig(): AutonomyConfig;
  setConfig(next: AutonomyConfig): void;
  state: StateStore;
  scheduler: Scheduler;
  isLive(sessionId: string): boolean;
  /** Create a fresh session for her own room and return its id. */
  createWakeSession?: () => Promise<string>;
  log(message: string): void;
}

export class PanelService {
  readonly #deps: PanelServiceDeps;
  readonly #listeners = new Set<() => void>();

  constructor(deps: PanelServiceDeps) {
    this.#deps = deps;
  }

  /** Subscribe to change notifications (SSE fan-out). */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* a dead stream must not stop the others */
      }
    }
  }

  /**
   * The wake room owns the ledger: intents she wrote while a real conversation
   * was running still have to show up under the room she actually wakes in,
   * otherwise the panel claims she owes nothing while the framing ranks three
   * items.
   */
  #ledgerFor(sessionId: string, own: Intent[], home: string): Array<{ intent: Intent; ownerSessionId: string }> {
    if (home === '' || home !== sessionId) return own.map((intent) => ({ intent, ownerSessionId: sessionId }));
    const seen = new Set<string>();
    const out: Array<{ intent: Intent; ownerSessionId: string }> = [];
    for (const sid of [sessionId, ...this.#deps.state.sessionIds()]) {
      const entry = this.#deps.state.session(sid);
      if (entry === undefined) continue;
      for (const intent of entry.intents) {
        if (!isOpen(intent)) continue;
        const key = fingerprint(intent.text);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ intent, ownerSessionId: sid });
      }
    }
    return out;
  }

  snapshot(focus?: string): PanelSnapshot {
    const now = Date.now();
    const config = this.#deps.getConfig();
    const managed = new Set(this.#deps.scheduler.managedSessions());
    // Cold sessions keep their history: a run recorded weeks ago must still be
    // visible even when nothing is live right now.
    const ids = new Set<string>([
      ...managed,
      ...this.#deps.state.sessionIds(),
      ...(focus === undefined ? [] : [focus]),
    ]);
    const sessions: SessionRow[] = [];
    for (const sessionId of ids) {
      const state = this.#deps.state.session(sessionId, now);
      if (state === undefined) continue;
      sessions.push({
        sessionId,
        live: this.#deps.isLive(sessionId),
        supervised: managed.has(sessionId),
        lastActivityAt: state.lastActivityAt,
        nextCheckAt: state.nextCheckAt,
        selfWake: state.selfWake === undefined ? null : { ...state.selfWake },
        lastSelfWake: state.lastSelfWake === undefined ? null : { ...state.lastSelfWake },
        openIntents: this.#ledgerFor(sessionId, state.intents.filter(isOpen), config.wakeSession.trim()).map(({ intent, ownerSessionId }) =>
          toRow(intent, ownerSessionId),
        ),
        settledIntents: state.intents.filter((intent) => !isOpen(intent)).map((intent) => toRow(intent, sessionId)),
        runs: [...state.runs].reverse().slice(0, 20),
      });
    }
    // Sessions that have actually been judged are the interesting ones; the
    // panel picks the first row by default, so rank by recent runs first.
    sessions.sort((a, b) => {
      const activityA = a.runs.length > 0 ? a.lastActivityAt : 0;
      const activityB = b.runs.length > 0 ? b.lastActivityAt : 0;
      if (activityA !== activityB) return activityB - activityA;
      return a.sessionId.localeCompare(b.sessionId);
    });
    const zone = typeof this.#deps.timeZone === 'function' ? this.#deps.timeZone() : this.#deps.timeZone;
    const today = dayKey(now, zone);
    const todayRuns: RunRecord[] = [];
    for (const sessionId of ids) {
      const state = this.#deps.state.session(sessionId, now);
      if (state === undefined) continue;
      for (const run of state.runs) {
        if (dayKey(Date.parse(run.startedAt), zone) === today) todayRuns.push(run);
      }
    }
    todayRuns.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const room = config.wakeSession.trim();
    const outbox = room === '' ? [] : [...(this.#deps.state.session(room)?.outbox ?? [])].reverse().slice(0, 8);
    return { now, timeZone: zone, dataDir: this.#deps.dataDir, config, sessions, todayRuns, outbox };
  }

  /**
   * One page of judgement history across every session. The snapshot only
   * carries a per-session tail (and today's slice), which is not enough for a
   * page with real filtering and paging, so this walks the whole store.
   */
  runs(query: RunsQuery = {}): RunsPage {
    const now = Date.now();
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 20), 1), 200);
    const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
    const all: RunRecord[] = [];
    for (const sessionId of this.#deps.state.sessionIds()) {
      const state = this.#deps.state.session(sessionId, now);
      if (state === undefined) continue;
      all.push(...state.runs);
    }
    all.sort((a, b) => {
      const diff = Date.parse(b.startedAt) - Date.parse(a.startedAt);
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });
    const outcomeOf = (run: RunRecord): string => run.decision ?? run.status;
    const triggers: Record<string, number> = {};
    const outcomes: Record<string, number> = {};
    const needle = (query.q ?? '').trim().toLowerCase();
    const wanted = (value: string | undefined): string => (value ?? '').trim();
    const filtered = all.filter((run) => {
      const outcome = outcomeOf(run);
      triggers[run.trigger] = (triggers[run.trigger] ?? 0) + 1;
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      if (wanted(query.trigger) !== '' && run.trigger !== wanted(query.trigger)) return false;
      if (wanted(query.outcome) !== '' && outcome !== wanted(query.outcome)) return false;
      if (wanted(query.session) !== '' && run.sessionId !== wanted(query.session)) return false;
      if (needle !== '') {
        const hay = `${run.reason ?? ''} ${run.note ?? ''} ${run.sessionId} ${run.trigger} ${outcome}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    return { total: filtered.length, offset, limit, rows: filtered.slice(offset, offset + limit), outcomes, triggers };
  }

  async action(raw: unknown, focus?: string): Promise<{ ok: true; snapshot: PanelSnapshot } | { ok: false; error: { code: string; message: string } }> {
    const body = (raw ?? {}) as Record<string, unknown>;
    const type = typeof body['type'] === 'string' ? body['type'] : '';
    // A card that has not picked a session yet should still work: fall back to
    // the operator-supplied focus, then to the first supervised session.
    const requested = typeof body['sessionId'] === 'string' && body['sessionId'] !== '' ? body['sessionId'] : undefined;
    const target = requested ?? focus ?? this.#deps.scheduler.managedSessions()[0];
    const now = Date.now();

    try {
      switch (type) {
        case 'configure': {
          const patch = body['patch'];
          if (patch === null || typeof patch !== 'object') throw new Error('patch must be an object');
          const next = normalizeConfig(patch as Record<string, unknown>, this.#deps.getConfig());
          saveConfig(this.#deps.dataDir, next);
          this.#deps.setConfig(next);
          this.#deps.scheduler.rescheduleAll(now);
          break;
        }
        case 'create-wake-session': {
          if (this.#deps.createWakeSession === undefined) throw new Error('this host cannot create sessions');
          const created = await this.#deps.createWakeSession();
          const next = normalizeConfig({ wakeSession: created }, this.#deps.getConfig());
          saveConfig(this.#deps.dataDir, next);
          this.#deps.setConfig(next);
          this.#deps.scheduler.rescheduleAll(now);
          break;
        }
        case 'wake': {
          if (target === undefined) throw new Error('sessionId required');
          this.#deps.state.update(target, () => {}, now);
          void this.#deps.scheduler.runNow(target, 'panel trigger').then(() => this.notify());
          break;
        }
        case 'stop':
        case 'cancel-self': {
          if (target === undefined) throw new Error('sessionId required');
          this.#deps.state.update(target, (state) => {
            delete state.selfWake;
            if (type === 'stop') state.nextCheckAt = 0;
          }, now);
          break;
        }
        case 'intent-create': {
          if (target === undefined) throw new Error('sessionId required');
          const kind = body['kind'] === 'agreement' ? 'agreement' : 'thought';
          const created = createIntent(
            {
              text: typeof body['text'] === 'string' ? body['text'] : '',
              kind,
              source: 'self',
              ...(typeof body['preferredAt'] === 'string' && body['preferredAt'] !== '' ? { preferredAt: body['preferredAt'] } : {}),
              ...(typeof body['dueAt'] === 'string' && body['dueAt'] !== '' ? { dueAt: body['dueAt'] } : {}),
            },
            new Date(now),
            () => `p${Math.random().toString(16).slice(2, 10)}`,
          );
          if (!created.ok) throw new Error(created.error);
          this.#deps.state.update(target, (state) => {
            state.intents = [...state.intents, created.value];
          }, now);
          break;
        }
        case 'intent-settle': {
          if (target === undefined) throw new Error('sessionId required');
          const id = typeof body['id'] === 'string' ? body['id'] : '';
          const nextState = body['state'] === 'abandoned' ? 'abandoned' : 'done';
          const version = typeof body['version'] === 'number' ? body['version'] : -1;
          const reason = typeof body['reason'] === 'string' && body['reason'] !== '' ? body['reason'] : undefined;
          // A row shown in the wake room may live in another session's ledger:
          // the aggregated view borrows rows, so settle where the row really is.
          let owner = target;
          let intent = this.#deps.state.session(target, now)?.intents.find((row) => row.id === id);
          if (intent === undefined) {
            for (const sid of this.#deps.state.sessionIds()) {
              const hit = this.#deps.state.session(sid)?.intents.find((row) => row.id === id);
              if (hit !== undefined) {
                owner = sid;
                intent = hit;
                break;
              }
            }
          }
          if (intent === undefined) throw new Error(`no intent ${id}`);
          const settled = settleIntent(intent, nextState, version, reason, new Date(now));
          if (!settled.ok) throw new Error(settled.error);
          this.#deps.state.update(owner, (entry) => {
            entry.intents = entry.intents.map((row) => (row.id === id ? settled.value : row));
          }, now);
          break;
        }
        default:
          throw new Error(`unknown action ${type}`);
      }
    } catch (error) {
      return { ok: false, error: { code: 'bad_action', message: error instanceof Error ? error.message : String(error) } };
    }
    this.notify();
    return { ok: true, snapshot: this.snapshot(target) };
  }
}

/** Install the three routes; returns undefined when no webserver is composed. */
export function installPanelRoutes(ctx: Context, service: PanelService): (() => void) | undefined {
  const webserver = (ctx as unknown as { get(name: string, strict?: boolean): unknown }).get('webServer', false) as WebServerLike | undefined;
  if (webserver === undefined || webserver === null) {
    ctx.logger?.info?.('dsh-autonomy: no webserver composed; panel routes not installed.');
    return undefined;
  }
  const disposers: Array<() => void> = [];

  disposers.push(webserver.register({
    kind: 'exact',
    path: '/api/dsh-autonomy/state',
    handler: (req, res) => {
      try {
        writeJson(res, 200, service.snapshot(sessionParam(req)));
      } catch (error) {
        writeJson(res, 500, { code: 'internal_error', message: String(error) });
      }
    },
  }));

  disposers.push(webserver.register({
    kind: 'exact',
    path: '/api/dsh-autonomy/runs',
    handler: (req, res) => {
      try {
        writeJson(res, 200, service.runs(runsQuery(req)));
      } catch (error) {
        writeJson(res, 500, { code: 'internal_error', message: String(error) });
      }
    },
  }));

  disposers.push(webserver.register({
    kind: 'exact',
    path: '/api/dsh-autonomy/action',
    handler: (req, res) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { code: 'bad_action', message: 'POST required' });
        return;
      }
      void readBoundedJson(req, BODY_MAX_BYTES)
        .then((body) => service.action(body, sessionParam(req)))
        .then((result) => {
          if (result.ok) writeJson(res, 200, result.snapshot);
          else writeJson(res, 400, result.error);
        })
        .catch((error: unknown) => {
          writeJson(res, 400, { code: 'bad_action', message: error instanceof Error ? error.message : String(error) });
        });
    },
  }));

  disposers.push(webserver.register({
    kind: 'exact',
    path: '/api/dsh-autonomy/events',
    handler: (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      let closed = false;
      const send = (payload: string): void => {
        if (closed || res.writableEnded === true) return;
        res.write(payload);
      };
      const notify = (): void => send('event: changed\ndata: {"now":"' + new Date().toISOString() + '"}\n\n');
      const unsubscribe = service.onChange(notify);
      const heartbeat = setInterval(() => send(': keepalive\n\n'), HEARTBEAT_MS);
      heartbeat.unref?.();
      const cleanup = (): void => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.on('close', cleanup);
      send('event: hello\ndata: {}\n\n');
    },
  }));

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* route already gone */
      }
    }
  };
}

function sessionParam(req: HttpRequestLike): string | undefined {
  const url = typeof req.url === 'string' ? req.url : '';
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  for (const pair of query.split('&')) {
    const [key, value] = pair.split('=');
    if (key === 'session' && value !== undefined && value !== '') return decodeURIComponent(value);
  }
  return undefined;
}

function runsQuery(req: HttpRequestLike): RunsQuery {
  const url = typeof req.url === 'string' ? req.url : '';
  const params = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
  const number = (key: string): number | undefined => {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const text = (key: string): string | undefined => {
    const raw = params.get(key);
    return raw === null || raw.trim() === '' ? undefined : raw.trim();
  };
  return { limit: number('limit'), offset: number('offset'), trigger: text('trigger'), outcome: text('outcome'), session: text('session'), q: text('q') };
}
