/**
 * Shared browser half: the wire types of the panel API, the two fetch helpers,
 * the formatters, and the one stylesheet both surfaces draw from.
 *
 * Nothing here touches React or the slot service, so the settings card and the
 * standalone page can share it without either owning the other.
 */

export const PANEL_ID = 'autonomy';
export const STATE_URL = '/api/dsh-autonomy/state';
export const ACTION_URL = '/api/dsh-autonomy/action';
export const RUNS_URL = '/api/dsh-autonomy/runs';
export const EVENTS_URL = '/api/dsh-autonomy/events';

export interface AdaptiveView {
  recentMinutes: number;
  recentMultiplier: number;
  distantMinutes: number;
  distantMultiplier: number;
}

export interface ConfigView {
  intervalMinutes: number;
  jitterRatio: number;
  probability: number;
  mode: string;
  adaptive: AdaptiveView;
  sleepWindows: string[];
  timezone: string;
  allowSelfWake: boolean;
  motivation: string;
  selfWakeDuringSleep: boolean;
  maxRunsPerDay: number;
  minIdleMinutes: number;
  sessions: string[];
  wakeSession: string;
  speakTargets: string[];
  speakCooldownMinutes: number;
  scoreEnabled: boolean;
  scoreThreshold: number;
  reviewEnabled: boolean;
  reviewBatch: number;
  reviewMinGapMinutes: number;
  reviewMaxInputTokens: number;
  reviewMaxOutputTokens: number;
  enabled: boolean;
}

export interface IntentRow {
  id: string;
  /** Session that holds the row; absent means "the session this list came from". */
  ownerSessionId?: string;
  text: string;
  kind: string;
  state: string;
  version: number;
  dueAt?: string;
  preferredAt?: string;
  reason?: string;
  createdAt?: string;
  chill?: number;
  parkedUntil?: string;
}

export interface RunRow {
  id: string;
  sessionId: string;
  trigger: string;
  status: string;
  decision?: string;
  reason?: string;
  note?: string;
  startedAt: string;
  endedAt?: string;
}

export interface SessionRow {
  sessionId: string;
  live: boolean;
  supervised: boolean;
  lastActivityAt: number;
  nextCheckAt: number;
  selfWake: { at: number; note?: string } | null;
  lastSelfWake: { at: number; note?: string; firedAt: number } | null;
  openIntents: IntentRow[];
  settledIntents: IntentRow[];
  runs: RunRow[];
}

export interface OutboxRow {
  id: string;
  target: string;
  text: string;
  status: 'pending' | 'sent' | 'expired' | 'failed';
  createdAt: number;
  expiresAt: number;
  note?: string;
}

export interface Snapshot {
  now: number;
  timeZone: string;
  dataDir: string;
  config: ConfigView;
  sessions: SessionRow[];
  todayRuns: RunRow[];
  outbox: OutboxRow[];
}

export interface RunsPage {
  total: number;
  offset: number;
  limit: number;
  rows: RunRow[];
  outcomes: Record<string, number>;
  triggers: Record<string, number>;
}

/** One intent shown in the global ledger, tagged with the session holding it. */
export interface LedgerEntry extends IntentRow {
  sessionId: string;
  /** True when this row came from the wake room's cross-session aggregation. */
  aggregated: boolean;
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`请求失败 ${response.status}`);
  return (await response.json()) as T;
}

export async function postAction(body: Record<string, unknown>, sessionId?: string): Promise<Snapshot> {
  const url = sessionId === undefined || sessionId === '' ? ACTION_URL : `${ACTION_URL}?session=${encodeURIComponent(sessionId)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sessionId === undefined || sessionId === '' ? body : { ...body, sessionId }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (payload as { message?: string } | null)?.message;
    throw new Error(message ?? `请求失败 ${response.status}`);
  }
  return payload as Snapshot;
}

export function shortId(sessionId: string): string {
  const match = /^session-([0-9a-f]{8})/.exec(sessionId);
  return match === null ? sessionId : (match[1] ?? sessionId);
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** `MM-DD HH:mm:ss` in the browser's zone. */
export function fmtTime(epoch: number): string {
  if (!Number.isFinite(epoch) || epoch <= 0) return '—';
  const date = new Date(epoch);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `HH:mm:ss`, for rows that already sit under a day heading. */
export function fmtClock(epoch: number): string {
  if (!Number.isFinite(epoch) || epoch <= 0) return '—';
  const date = new Date(epoch);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function fmtDay(epoch: number): string {
  if (!Number.isFinite(epoch) || epoch <= 0) return '—';
  const date = new Date(epoch);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `in 8m` / `3h ago`, for next-check countdowns. */
export function fmtDelta(target: number, now: number): string {
  if (!Number.isFinite(target) || target <= 0) return '—';
  const diff = target - now;
  const minutes = Math.round(Math.abs(diff) / 60_000);
  const text = minutes < 60 ? `${minutes} 分钟` : minutes < 60 * 24 ? `${Math.round(minutes / 60)} 小时` : `${Math.round(minutes / 1440)} 天`;
  return diff >= 0 ? `${text}后` : `${text}前`;
}

export const OUTCOME_LABEL: Record<string, string> = {
  acted: '动手了',
  no_action: '安静收着',
  busy: '会话正忙',
  running: '正在跑',
  settling: '收尾中',
  queued: '排队中',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '被打断',
  uncertain: '看不清',
};

export const TRIGGER_LABEL: Record<string, string> = {
  random: '掷骰',
  self: '她自己排的',
  manual: '手动',
  agreement: '约定的',
};

export function outcomeLabel(value: string | undefined): string {
  if (value === undefined || value === '') return '—';
  return OUTCOME_LABEL[value] ?? value;
}

export function triggerLabel(value: string | undefined): string {
  if (value === undefined || value === '') return '—';
  return TRIGGER_LABEL[value] ?? value;
}

export function outcomeTone(value: string | undefined): string {
  if (value === 'acted') return 'good';
  if (value === 'no_action') return 'calm';
  if (value === 'failed' || value === 'interrupted' || value === 'cancelled') return 'bad';
  return 'muted';
}

const CSS = `
.da-surface{--da-border:var(--dsw-alias-border-l2,rgba(0,0,0,.12));--da-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));--da-text:var(--dsw-alias-label-primary,#0f1115);--da-text-2:var(--dsw-alias-label-secondary,#57585a);--da-text-3:var(--dsw-alias-label-tertiary,#81858c);--da-accent:var(--dsw-alias-button-info-fill,#3964fe);--da-bad:var(--dsw-alias-state-error-primary,#e5484d);--da-good:var(--dsw-alias-state-success-primary,#30a46c);font-family:var(--dsw-font-family,inherit);color:var(--da-text);}
.da-page{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-l1,#fff);border-radius:0;}
.da-head{display:flex;flex-direction:column;gap:6px;padding:16px 22px 0;}
.da-head-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.da-h1{font-size:17px;font-weight:650;letter-spacing:.2px;}
.da-sub{font-size:12px;color:var(--da-text-3);line-height:18px;}
.da-spacer{flex:1;}
.da-tabs{display:flex;gap:4px;padding:10px 22px 0;border-bottom:1px solid var(--da-border);}
.da-tab{height:36px;padding:0 14px;border:none;background:transparent;color:var(--da-text-2);font:inherit;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;}
.da-tab:hover{color:var(--da-text);}
.da-tab.active{color:var(--da-text);border-bottom-color:var(--da-accent);font-weight:600;}
.da-body{flex:1;min-height:0;overflow:auto;padding:18px 22px 32px;display:flex;flex-direction:column;gap:16px;}
.da-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px 14px;}
.da-field{display:flex;flex-direction:column;gap:4px;min-width:0;}
.da-label{font-size:11px;color:var(--da-text-2);line-height:15px;}
.da-hint{font-size:10px;color:var(--da-text-3);line-height:14px;}
.da-input,.da-select{height:28px;border:1px solid var(--da-border);border-radius:7px;background:var(--dsw-specific-input-major,#fff);color:inherit;font:inherit;font-size:12px;padding:0 8px;min-width:0;}
.da-input:focus,.da-select:focus{outline:none;border-color:var(--da-accent);}
.da-input:disabled,.da-select:disabled{opacity:.5;}
.da-check{display:flex;align-items:center;gap:6px;height:28px;font-size:12px;color:var(--da-text);}
.da-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.da-btn{height:28px;padding:0 12px;border-radius:7px;border:1px solid var(--da-border);background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;}
.da-btn:hover:not(:disabled){background:var(--da-hover);}
.da-btn:disabled{opacity:.45;cursor:default;}
.da-btn.primary{background:var(--da-accent);border-color:transparent;color:#fff;}
.da-btn.primary:hover:not(:disabled){filter:brightness(.94);}
.da-btn.danger{color:var(--da-bad);}
.da-btn.small{height:24px;padding:0 8px;font-size:11px;border-radius:6px;}
.da-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;}
.da-card{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:1px solid var(--da-border);border-radius:12px;background:var(--dsw-alias-bg-l2,transparent);}
.da-card-label{font-size:11px;color:var(--da-text-3);}
.da-card-value{font-size:22px;font-weight:650;line-height:26px;font-variant-numeric:tabular-nums;}
.da-card-note{font-size:11px;color:var(--da-text-3);line-height:15px;}
.da-section{display:flex;flex-direction:column;gap:8px;}
.da-section-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}
.da-section-title{font-size:13px;font-weight:600;}
.da-filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.da-chip{height:26px;padding:0 11px;border-radius:999px;border:1px solid var(--da-border);background:transparent;color:var(--da-text-2);font:inherit;font-size:12px;cursor:pointer;}
.da-chip:hover{background:var(--da-hover);}
.da-chip.active{background:var(--da-accent);border-color:transparent;color:#fff;font-weight:600;}
.da-body>*{flex-shrink:0;}
.da-list{display:flex;flex-direction:column;border:1px solid var(--da-border);border-radius:12px;overflow:hidden;flex:none;}
.da-item{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;font-size:12px;line-height:19px;border-top:1px solid var(--da-border);}
.da-item:first-child{border-top:none;}
.da-item:hover{background:var(--da-hover);}
.da-item-text{flex:1;min-width:0;word-break:break-word;}
.da-item-time{flex:none;width:74px;color:var(--da-text-3);font-variant-numeric:tabular-nums;}
.da-item-day{flex:none;width:74px;color:var(--da-text-2);font-variant-numeric:tabular-nums;}
.da-tag{flex:none;font-size:10px;color:var(--da-text-3);border:1px solid var(--da-border);border-radius:999px;padding:0 7px;line-height:17px;white-space:nowrap;}
.da-tag.good{color:var(--da-good);border-color:color-mix(in srgb,var(--da-good) 40%,transparent);}
.da-tag.bad{color:var(--da-bad);border-color:color-mix(in srgb,var(--da-bad) 40%,transparent);}
.da-tag.calm{color:var(--da-text-2);}
.da-meta{font-size:11px;color:var(--da-text-3);white-space:nowrap;}
.da-empty{padding:26px 14px;text-align:center;font-size:12px;color:var(--da-text-3);border:1px dashed var(--da-border);border-radius:12px;}
.da-err{font-size:12px;color:var(--da-bad);word-break:break-word;}
.da-pager{display:flex;align-items:center;gap:10px;justify-content:flex-end;font-size:12px;color:var(--da-text-2);}
.da-sched{display:flex;flex-direction:column;gap:10px;}
.da-sched-row{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:1px solid var(--da-border);border-radius:12px;}
.da-sched-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.da-sched-id{font-size:12px;font-weight:600;}
.da-sched-facts{display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--da-text-3);}
.da-card-surface{display:flex;flex-direction:column;gap:12px;}
.da-sep{height:1px;background:var(--da-border);}
`;

let injected = false;

export function injectStyle(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.id = 'dsh-autonomy/client.css';
  style.textContent = CSS;
  document.head.appendChild(style);
}
