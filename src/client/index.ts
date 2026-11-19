/**
 * Browser half of dsh-autonomy: one settings.section card.
 *
 * Three things an operator changes here and nothing else: the rhythm (interval,
 * jitter, probability, adaptive mode), the quiet windows, and the target
 * sessions. Below that the card shows the intent ledger and the last few
 * judgements, with buttons for the two manual actions ("判断一次" and
 * "结束并取消排队") that the AstrBot page has.
 *
 * Registering a slot is allowed to fail on a GUI without the settings page; it
 * is logged, never thrown, so an external plugin cannot take the GUI down.
 */

import type { Context } from '@deepseek-ai/cordis';
import * as ReactNS from 'react';
import type { ReactElement } from 'react';

const PLUGIN_ID = 'dsh-autonomy';
const NS = 'dsh-autonomy';
const STATE_URL = '/api/dsh-autonomy/state';
const ACTION_URL = '/api/dsh-autonomy/action';
const EVENTS_URL = '/api/dsh-autonomy/events';

export const inject = ['slots', 'remote', 'connection', 'locale'];

type ReactModule = typeof import('react');

/** The slice of the client slot service this card touches. */
interface SlotsLike {
  inject(name: string, factory: () => unknown): void;
  register(spec: Record<string, unknown>, component: (props: Record<string, never>) => ReactElement): () => void;
}

interface ConfigView {
  intervalMinutes: number;
  jitterRatio: number;
  probability: number;
  mode: string;
  adaptive: {
    recentMinutes: number;
    recentMultiplier: number;
    distantMinutes: number;
    distantMultiplier: number;
  };
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
  enabled: boolean;
}

interface IntentRow {
  id: string;
  text: string;
  kind: string;
  state: string;
  version: number;
  dueAt?: string;
  preferredAt?: string;
  reason?: string;
}

interface RunRow {
  id: string;
  sessionId: string;
  trigger: string;
  status: string;
  decision?: string;
  reason?: string;
  startedAt: string;
  endedAt?: string;
}

interface SessionRow {
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

interface Snapshot {
  now: number;
  timeZone: string;
  dataDir: string;
  config: ConfigView;
  sessions: SessionRow[];
  todayRuns: RunRow[];
}

const CSS = `
.dsh-autonomy-card{display:flex;flex-direction:column;gap:14px;font-family:var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary,#0f1115);}
.dsh-autonomy-title{font-size:13px;font-weight:600;}
.dsh-autonomy-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);line-height:16px;}
.dsh-autonomy-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px 12px;}
.dsh-autonomy-field{display:flex;flex-direction:column;gap:3px;min-width:0;}
.dsh-autonomy-label{font-size:11px;color:var(--dsw-alias-label-secondary,#57585a);}
.dsh-autonomy-input,.dsh-autonomy-select{height:26px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-specific-input-major,#fff);color:inherit;font:inherit;font-size:12px;padding:0 6px;min-width:0;}
.dsh-autonomy-input:disabled,.dsh-autonomy-select:disabled{opacity:.5;}
.dsh-autonomy-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.dsh-autonomy-btn{height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;}
.dsh-autonomy-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}
.dsh-autonomy-btn:disabled{opacity:.45;cursor:default;}
.dsh-autonomy-btn.primary{background:var(--dsw-alias-button-info-fill,#3964fe);border-color:transparent;color:#fff;}
.dsh-autonomy-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,#2b55e0);}
.dsh-autonomy-section{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));padding-top:10px;}
.dsh-autonomy-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.dsh-autonomy-list{display:flex;flex-direction:column;gap:5px;max-height:200px;overflow-y:auto;}
.dsh-autonomy-item{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:18px;padding:4px 6px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.03));}
.dsh-autonomy-item-text{flex:1;min-width:0;word-break:break-word;}
.dsh-autonomy-tag{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#81858c);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:999px;padding:0 6px;line-height:16px;}
.dsh-autonomy-empty{font-size:11px;color:var(--dsw-alias-label-caption,#a1a3a8);}
.dsh-autonomy-err{font-size:11px;color:var(--dsw-alias-state-error-primary,#e5484d);word-break:break-word;}
.dsh-autonomy-meta{font-size:10px;color:var(--dsw-alias-label-tertiary,#81858c);}
`;

let styleInjected = false;
function injectStyle(): void {
  if (styleInjected || typeof document === 'undefined') return;
  styleInjected = true;
  const style = document.createElement('style');
  style.id = '@dsh-autonomy/client.css';
  style.textContent = CSS;
  document.head.appendChild(style);
}

function shortId(sessionId: string): string {
  const match = /^session-([0-9a-f]{8})/.exec(sessionId);
  return match === null ? sessionId : match[1] ?? sessionId;
}

function fmtTime(epoch: number): string {
  if (!Number.isFinite(epoch) || epoch <= 0) return '—';
  const date = new Date(epoch);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function apply(ctx: Context): void {
  injectStyle();
  // React arrives through the loader-provided `require`; the bundle stays
  // externalized, so `react` here is the host's own copy.
  const React = ReactNS as unknown as ReactModule;
  const h = React.createElement;
  if (h === undefined) {
    console.error('[dsh-autonomy] react unavailable; settings card not mounted');
    return;
  }

  function AutonomyCard(): ReactElement {
    const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [sessionId, setSessionId] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [draft, setDraft] = React.useState<Record<string, string>>({});
    const [intentText, setIntentText] = React.useState('');
    const [intentKind, setIntentKind] = React.useState('thought');

    const query = (): string => (sessionId === '' ? '' : `?session=${encodeURIComponent(sessionId)}`);

    const pull = React.useCallback(async () => {
      try {
        const response = await fetch(`${STATE_URL}${query()}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`state ${response.status}`);
        setSnapshot((await response.json()) as Snapshot);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }, [sessionId]);

    const act = React.useCallback(async (body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const response = await fetch(`${ACTION_URL}${query()}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, ...(sessionId === '' ? {} : { sessionId }) }),
        });
        const payload = (await response.json()) as Snapshot | { code?: string; message?: string };
        if (!response.ok) {
          const message = (payload as { message?: string }).message;
          throw new Error(message ?? `action ${response.status}`);
        }
        setSnapshot(payload as Snapshot);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    }, [sessionId]);

    React.useEffect(() => {
      void pull();
    }, [pull]);

    // Select the first supervised session once, so the buttons work without
    // the operator having to paste an id.
    React.useEffect(() => {
      if (sessionId !== '' || snapshot === null) return;
      const first = snapshot.sessions[0];
      if (first !== undefined) setSessionId(first.sessionId);
    }, [snapshot, sessionId]);

    React.useEffect(() => {
      if (typeof EventSource === 'undefined') return undefined;
      const source = new EventSource(EVENTS_URL);
      const onChanged = (): void => {
        void pull();
      };
      source.addEventListener('changed', onChanged);
      return () => {
        source.removeEventListener('changed', onChanged);
        source.close();
      };
    }, [pull]);

    const config = snapshot?.config;
    const field = (key: string, label: string, value: number | string, narrow = false): ReactElement => {
      const raw = draft[key];
      return h!('label', { className: 'dsh-autonomy-field' },
        h!('span', { className: 'dsh-autonomy-label' }, label),
        h!('input', {
          className: 'dsh-autonomy-input',
          type: narrow ? 'number' : 'text',
          step: narrow ? 'any' : undefined,
          value: raw === undefined ? String(value) : raw,
          disabled: busy,
          onChange: (event: { target: { value: string } }) => {
            setDraft((current) => ({ ...current, [key]: event.target.value }));
          },
        }),
      );
    };

    const saveConfig = (): void => {
      const patch: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(draft)) {
        if (raw.trim() === '') continue;
        if (key === 'sleepWindows' || key === 'sessions' || key === 'speakTargets') {
          patch[key] = raw.split(',').map((part) => part.trim()).filter((part) => part !== '');
        } else if (key === 'mode') {
          patch[key] = raw.trim();
        } else if (key === 'enabled' || key === 'selfWakeDuringSleep' || key === 'allowSelfWake') {
          patch[key] = raw.trim() === 'true';
        } else {
          const number = Number(raw);
          if (Number.isFinite(number)) patch[key] = number;
        }
      }
      void act({ type: 'configure', patch }).then(() => setDraft({}));
    };

    if (snapshot === null) {
      return h!('div', { className: 'dsh-autonomy-card' },
        h!('div', { className: 'dsh-autonomy-title' }, 'Autonomy'),
        error === null
          ? h!('div', { className: 'dsh-autonomy-empty' }, '载入中…')
          : h!('div', { className: 'dsh-autonomy-err' }, `读取失败：${error}`),
      );
    }

    const activeRow = snapshot.sessions.find((row) => row.sessionId === sessionId)
      ?? snapshot.sessions[0];

    return h!('div', { className: 'dsh-autonomy-card' },
      h!('div', { className: 'dsh-autonomy-row' },
        h!('div', { className: 'dsh-autonomy-title' }, 'Autonomy · 自主意识'),
        h!('span', { className: 'dsh-autonomy-tag' }, config?.enabled ? '运行中' : '已停用'),
        h!('span', { className: 'dsh-autonomy-meta' }, snapshot.timeZone),
        h!('span', { style: { flex: 1 } }),
        h!('button', { className: 'dsh-autonomy-btn', disabled: busy, onClick: () => void pull() }, '刷新'),
      ),
      h!('div', { className: 'dsh-autonomy-sub' },
        '宿主按平均间隔掷骰决定要不要唤醒；醒来后由模型自己决定行动还是沉默。'
        + `数据目录 ${snapshot.dataDir}`),

      h!('div', { className: 'dsh-autonomy-grid' },
        field('intervalMinutes', '平均间隔（分钟）', config?.intervalMinutes ?? 30, true),
        field('jitterRatio', '抖动比例（0.1 = ±10%）', config?.jitterRatio ?? 0.1, true),
        field('probability', '唤醒概率（0-1）', config?.probability ?? 0.2, true),
        field('mode', '概率模式（fixed / adaptive）', config?.mode ?? 'fixed'),
        field('sleepWindows', '睡眠时段（HH:mm-HH:mm 或 23:00-08:00@5-1，逗号分隔）', (config?.sleepWindows ?? []).join(',')),
        field('maxRunsPerDay', '每日上限（0 = 不限）', config?.maxRunsPerDay ?? 20, true),
        field('minIdleMinutes', '最近活动后跳过（分钟）', config?.minIdleMinutes ?? 0, true),
        field('wakeSession', '唤醒落点（留空 = 按下面的目标会话列表）', config?.wakeSession ?? ''),
        field('speakTargets', '许她说话的去处（group:群号 / private:QQ号，逗号分隔）', (config?.speakTargets ?? []).join(',')),
        field('sessions', '目标会话（留空 = 全部根会话；唤醒落点非空时忽略）', (config?.sessions ?? []).join(',')),
        field('timezone', '时区（留空 = 宿主时区）', config?.timezone ?? ''),
        field('allowSelfWake', '允许她自排唤醒（true / false）', String(config?.allowSelfWake ?? true)),
        field('motivation', '自主回合开场白（留空 = 内置）', config?.motivation ?? ''),
        field('enabled', '启用（true / false）', String(config?.enabled ?? true)),
      ),
      h!('div', { className: 'dsh-autonomy-row' },
        h!('button', { className: 'dsh-autonomy-btn primary', disabled: busy, onClick: saveConfig }, '保存配置'),
        h!('button', {
          className: 'dsh-autonomy-btn',
          disabled: busy,
          onClick: () => void act({ type: 'create-wake-session' }),
        }, '建一个她的会话（落点指过去）'),
        Object.keys(draft).length > 0
          ? h!('button', { className: 'dsh-autonomy-btn', disabled: busy, onClick: () => setDraft({}) }, '撤销修改')
          : null,
        error !== null ? h!('span', { className: 'dsh-autonomy-err' }, error) : null,
      ),

      h!('div', { className: 'dsh-autonomy-section' },
        h!('div', { className: 'dsh-autonomy-section-head' },
          h!('span', { className: 'dsh-autonomy-label' }, '会话'),
          h!('span', { className: 'dsh-autonomy-meta' }, `${snapshot.sessions.length} 个已记录会话（${snapshot.sessions.filter((row) => row.live).length} 个在跑）`),
        ),
        h!('div', { className: 'dsh-autonomy-row' },
          h!('input', {
            className: 'dsh-autonomy-input',
            style: { flex: 1, minWidth: '200px' },
            placeholder: '会话 id（留空 = 第一个在跑的会话）',
            value: sessionId,
            onChange: (event: { target: { value: string } }) => setSessionId(event.target.value),
          }),
          h!('button', { className: 'dsh-autonomy-btn primary', disabled: busy, onClick: () => void act({ type: 'wake' }) }, '现在判断一次'),
          h!('button', { className: 'dsh-autonomy-btn', disabled: busy, onClick: () => void act({ type: 'cancel-self' }) }, '取消自排唤醒'),
          h!('button', { className: 'dsh-autonomy-btn', disabled: busy, onClick: () => void act({ type: 'stop' }) }, '结束并取消排队'),
        ),
        activeRow === undefined
          ? h!('div', { className: 'dsh-autonomy-empty' }, '还没有记录到会话：先在目标会话里聊一句，或在上面的「目标会话」里填 id。')
          : h!('div', { className: 'dsh-autonomy-meta' },
            `${activeRow.sessionId} · ${activeRow.live ? '在线' : '冷会话（唤醒需 resume，本版未实测）'}`
            + ` · 下次掷骰 ${fmtTime(activeRow.nextCheckAt)}`
            + ` · 上次活动 ${fmtTime(activeRow.lastActivityAt)}`
            + (activeRow.selfWake === null ? '' : ` · 自排 ${fmtTime(activeRow.selfWake.at)}`)),
      ),

      h!('div', { className: 'dsh-autonomy-section' },
        h!('div', { className: 'dsh-autonomy-section-head' },
          h!('span', { className: 'dsh-autonomy-label' }, '她的排程'),
          h!('span', { className: 'dsh-autonomy-meta' },
            activeRow === undefined
              ? '未选中会话'
              : (activeRow.selfWake === null ? '当前没有待触发的自排唤醒' : '有 1 条待触发的自排唤醒')),
        ),
        activeRow === undefined
          ? null
          : h!('div', {},
            h!('div', { className: 'dsh-autonomy-meta' }, `下一次随机掷骰：${fmtTime(activeRow.nextCheckAt)}`),
            activeRow.selfWake === null
              ? h!('div', { className: 'dsh-autonomy-empty' },
                activeRow.lastSelfWake === null
                  ? '她还没给自己排过唤醒。她在自主判断里调用 autonomy_schedule 之后，这里会显示时间与原因。'
                  : `最近一次自排：原定 ${fmtTime(activeRow.lastSelfWake.at)}，已于 ${fmtTime(activeRow.lastSelfWake.firedAt)} 触发（原因：${activeRow.lastSelfWake.note ?? '未填'}）`)
              : h!('div', { className: 'dsh-autonomy-row' },
                h!('span', { className: 'dsh-autonomy-meta' },
                  `她自己排的：${fmtTime(activeRow.selfWake.at)}`
                  + (activeRow.selfWake.note === undefined ? '' : ` · ${activeRow.selfWake.note}`)),
                h!('button', { className: 'dsh-autonomy-btn', disabled: busy, onClick: () => void act({ type: 'cancel-self' }) }, '取消这条'),
              ),
          ),
      ),

      h!('div', { className: 'dsh-autonomy-section' },
        h!('div', { className: 'dsh-autonomy-section-head' },
          h!('span', { className: 'dsh-autonomy-label' }, `意图台账（${activeRow?.openIntents.length ?? 0} 条未完成）`),
        ),
        h!('div', { className: 'dsh-autonomy-row' },
          h!('select', {
            className: 'dsh-autonomy-select',
            value: intentKind,
            disabled: busy,
            onChange: (event: { target: { value: string } }) => setIntentKind(event.target.value),
          },
          h!('option', { value: 'thought' }, '想法'),
          h!('option', { value: 'agreement' }, '约定')),
          h!('input', {
            className: 'dsh-autonomy-input',
            style: { flex: 1, minWidth: '160px' },
            placeholder: '要记下来的事',
            value: intentText,
            disabled: busy,
            onChange: (event: { target: { value: string } }) => setIntentText(event.target.value),
          }),
          h!('button', {
            className: 'dsh-autonomy-btn',
            disabled: busy || intentText.trim() === '' || sessionId === '',
            onClick: () => {
              void act({ type: 'intent-create', text: intentText.trim(), kind: intentKind })
                .then(() => setIntentText(''));
            },
          }, '新增'),
        ),
        (activeRow?.openIntents.length ?? 0) === 0
          ? h!('div', { className: 'dsh-autonomy-empty' }, '没有未完成的意图。')
          : h!('div', { className: 'dsh-autonomy-list' },
            (activeRow?.openIntents ?? []).map((intent) => h!('div', { className: 'dsh-autonomy-item', key: intent.id },
              h!('span', { className: 'dsh-autonomy-tag' }, intent.kind === 'agreement' ? '约定' : '想法'),
              h!('span', { className: 'dsh-autonomy-item-text' }, intent.text),
              h!('button', {
                className: 'dsh-autonomy-btn',
                disabled: busy,
                onClick: () => void act({ type: 'intent-settle', id: intent.id, state: 'done', version: intent.version }),
              }, '完成'),
              h!('button', {
                className: 'dsh-autonomy-btn',
                disabled: busy,
                onClick: () => void act({ type: 'intent-settle', id: intent.id, state: 'abandoned', version: intent.version }),
              }, '放弃'),
            ))),
      ),

      h!('div', { className: 'dsh-autonomy-section' },
        h!('div', { className: 'dsh-autonomy-section-head' },
          h!('span', { className: 'dsh-autonomy-label' }, `今天的判断（所有会话 · ${snapshot.todayRuns.length} 条）`),
          h!('span', { className: 'dsh-autonomy-meta' }, `按 ${snapshot.timeZone} 的今天`),
        ),
        snapshot.todayRuns.length === 0
          ? h!('div', { className: 'dsh-autonomy-empty' }, '今天还没有判断记录。')
          : h!('div', { className: 'dsh-autonomy-list' },
            snapshot.todayRuns.map((row) => h!('div', { className: 'dsh-autonomy-item', key: `${row.sessionId}:${row.id}` },
              h!('span', { className: 'dsh-autonomy-tag' }, row.trigger),
              h!('span', { className: 'dsh-autonomy-tag' }, row.decision ?? row.status),
              h!('span', { className: 'dsh-autonomy-item-text' }, row.reason ?? ''),
              h!('span', { className: 'dsh-autonomy-meta' }, shortId(row.sessionId)),
              h!('span', { className: 'dsh-autonomy-meta' }, fmtTime(Date.parse(row.startedAt))),
            ))),
      ),

      h!('div', { className: 'dsh-autonomy-section' },
        h!('div', { className: 'dsh-autonomy-section-head' },
          h!('span', { className: 'dsh-autonomy-label' }, '最近的判断'),
        ),
        (activeRow?.runs.length ?? 0) === 0
          ? h!('div', { className: 'dsh-autonomy-empty' }, '还没有判断记录。')
          : h!('div', { className: 'dsh-autonomy-list' },
            (activeRow?.runs ?? []).map((run) => h!('div', { className: 'dsh-autonomy-item', key: run.id },
              h!('span', { className: 'dsh-autonomy-tag' }, run.trigger),
              h!('span', { className: 'dsh-autonomy-tag' }, run.status),
              h!('span', { className: 'dsh-autonomy-tag' }, run.decision ?? '—'),
              h!('span', { className: 'dsh-autonomy-item-text' }, run.reason ?? ''),
              h!('span', { className: 'dsh-autonomy-meta' }, fmtTime(Date.parse(run.startedAt))),
            ))),
      ),
    );
  }

  const slots = (ctx as unknown as { slots?: SlotsLike }).slots;
  if (slots === undefined) {
    console.error('[dsh-autonomy] slots service unavailable; settings card not mounted');
    return;
  }
  try {
    slots.inject('settings.section', () =>
      slots.register(
        {
          name: 'settings.section',
          id: PLUGIN_ID,
          order: 130,
          locale: NS,
          label: () => 'Autonomy',
          inject: () => ({}),
        },
        AutonomyCard,
      ),
    );
  } catch (error) {
    console.error('[dsh-autonomy] settings.section registration failed', error);
  }
}
