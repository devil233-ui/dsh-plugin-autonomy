/**
 * Host half of the panel: one snapshot GET, one closed action POST, one SSE
 * change stream. Same shape as the AstrBot page API (state / configure / wake /
 * stop / self-cancel) plus the two intent mutations the ledger needs.
 *
 * The webserver service is looked up loosely: a headless host composes no
 * webserver, and the plugin must still work there (tools + scheduler only).
 */

import type { Context } from '@deepseek-ai/cordis';

import { createIntent, isOpen, settleIntent, type Intent } from '../core/intent.js';
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
}

export type PanelAction =
  | { type: 'configure'; patch: Record<string, unknown> }
  | { type: 'wake'; sessionId?: string }
  | { type: 'stop'; sessionId?: string }
  | { type: 'cancel-self'; sessionId?: string }
  | { type: 'intent-create'; sessionId?: string; text: string; kind?: string; dueAt?: string; preferredAt?: string }
  | { type: 'intent-settle'; sessionId?: string; id: string; state: 'done' | 'abandoned'; version: number; reason?: string };

const BODY_MAX_BYTES = 64 * 1024;
const HEARTBEAT_MS = 25_000;

function toRow(intent: Intent): IntentRow {
  return {
    id: intent.id,
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

function writeJson(res: HttpResponseLike, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
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
  timeZone: string;
  getConfig(): AutonomyConfig;
  setConfig(next: AutonomyConfig): void;
  state: StateStore;
  scheduler: Scheduler;
  isLive(sessionId: string): boolean;
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
        openIntents: state.intents.filter(isOpen).map(toRow),
        settledIntents: state.intents.filter((intent) => !isOpen(intent)).map(toRow),
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
    return { now, timeZone: this.#deps.timeZone, dataDir: this.#deps.dataDir, config, sessions };
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
          const state = this.#deps.state.session(target, now);
          const intent = state?.intents.find((row) => row.id === id);
          if (intent === undefined) throw new Error(`no intent ${id}`);
          const settled = settleIntent(intent, nextState, version, reason, new Date(now));
          if (!settled.ok) throw new Error(settled.error);
          this.#deps.state.update(target, (entry) => {
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
