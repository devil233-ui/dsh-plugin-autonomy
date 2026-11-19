/**
 * Standalone page: the same data the settings card shows, but with room.
 *
 * The card exists because a plugin could only hang off the settings modal; it
 * stays as a status strip that jumps here. Everything with lists, filters and
 * paging lives on this surface, addressed from the sidebar like the built-in
 * "自动化任务" panel.
 */

import * as React from 'react';
import type { ReactElement } from 'react';

import { buildPatch, ConfigForm } from './config-form.js';
import {
  EVENTS_URL,
  RUNS_URL,
  STATE_URL,
  fmtClock,
  fmtDelta,
  fmtTime,
  getJson,
  outcomeLabel,
  outcomeTone,
  postAction,
  shortId,
  triggerLabel,
  type ConfigView,
  type LedgerEntry,
  type RunsPage,
  type SessionRow,
  type Snapshot,
} from './shared.js';

type Tab = 'overview' | 'runs' | 'ledger' | 'schedule' | 'config';

/** 面板自身的字号档位。用 zoom 整体缩放，省得逐个元素改 font-size。 */
const SCALE_KEY = 'dsh-autonomy:textScale';
const SCALE_STEPS = [
  { value: 0.85, label: '小' },
  { value: 1, label: '标准' },
  { value: 1.15, label: '大' },
  { value: 1.3, label: '特大' },
];

function loadScale(): number {
  try {
    const raw = Number(window.localStorage.getItem(SCALE_KEY));
    return SCALE_STEPS.some((step) => step.value === raw) ? raw : 1;
  } catch {
    return 1;
  }
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'runs', label: '判断记录' },
  { id: 'ledger', label: '意图台账' },
  { id: 'schedule', label: '排程' },
  { id: 'config', label: '配置' },
];

const pageCount = (total: number, limit: number): number => Math.max(1, Math.ceil(total / Math.max(limit, 1)));

/** Dedupe the wake room's cross-session aggregation by intent id. */
function outboxTag(status: string): string {
  if (status === 'pending') return '排着';
  if (status === 'sent') return '已发';
  if (status === 'expired') return '过期';
  return '没发成';
}

function ledgerRows(sessions: readonly SessionRow[], which: 'open' | 'settled'): LedgerEntry[] {
  const seen = new Set<string>();
  const out: LedgerEntry[] = [];
  for (const session of sessions) {
    const intents = which === 'open' ? session.openIntents : session.settledIntents;
    for (const intent of intents) {
      if (seen.has(intent.id)) continue;
      seen.add(intent.id);
      out.push({ ...intent, sessionId: intent.ownerSessionId ?? session.sessionId, aggregated: which === 'open' && intents !== undefined && session.supervised });
    }
  }
  return out;
}

export function AutonomyIcon({ size = 16, active = false }: { size?: number; active?: boolean }): ReactElement {
  // A dial with one hand: the rhythm, not a robot face.
  return React.createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: active ? 1.5 : 1.3,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  },
  React.createElement('circle', { cx: 8, cy: 8, r: 5.6 }),
  React.createElement('path', { d: 'M8 4.9V8l2.3 1.5' }),
  React.createElement('path', { d: 'M8 1.1v1.4M8 13.5v1.4M1.1 8h1.4M13.5 8h1.4' }),
  );
}

export function AutonomyPage(): ReactElement {
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [tab, setTab] = React.useState<Tab>('overview');
  const [runs, setRuns] = React.useState<RunsPage | null>(null);
  const [runsError, setRunsError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState({ page: 0, limit: 20, trigger: '', outcome: '', session: '', q: '' });
  const [scale, setScale] = React.useState<number>(loadScale);
  const pickScale = (next: number): void => {
    setScale(next);
    try {
      window.localStorage.setItem(SCALE_KEY, String(next));
    } catch {
      // 隐私模式下写不进去就算了，本次会话照样生效
    }
  };

  const pull = React.useCallback(async () => {
    try {
      setSnapshot(await getJson<Snapshot>(STATE_URL));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  React.useEffect(() => {
    void pull();
  }, [pull]);

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

  // Debounce the search box so a keystroke does not hit the host per character.
  const [debouncedQuery, setDebouncedQuery] = React.useState(query.q);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.q), 260);
    return () => clearTimeout(timer);
  }, [query.q]);

  const runsUrl = React.useMemo(() => {
    const params = new URLSearchParams({
      limit: String(query.limit),
      offset: String(query.page * query.limit),
    });
    if (query.trigger !== '') params.set('trigger', query.trigger);
    if (query.outcome !== '') params.set('outcome', query.outcome);
    if (query.session !== '') params.set('session', query.session);
    if (debouncedQuery.trim() !== '') params.set('q', debouncedQuery.trim());
    return `${RUNS_URL}?${params.toString()}`;
  }, [query.limit, query.page, query.trigger, query.outcome, query.session, debouncedQuery]);

  React.useEffect(() => {
    let alive = true;
    void getJson<RunsPage>(runsUrl)
      .then((page) => {
        if (!alive) return;
        setRuns(page);
        setRunsError(null);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setRunsError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, [runsUrl]);

  const act = React.useCallback(async (body: Record<string, unknown>, sessionId?: string) => {
    setBusy(true);
    try {
      setSnapshot(await postAction(body, sessionId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const config: ConfigView | undefined = snapshot?.config;
  const sessions = snapshot?.sessions ?? [];
  const targetSession = (config?.wakeSession ?? '').trim() !== ''
    ? (config?.wakeSession ?? '').trim()
    : (sessions.find((row) => row.supervised)?.sessionId ?? sessions[0]?.sessionId ?? '');
  const today = snapshot?.todayRuns ?? [];
  const acted = today.filter((run) => run.decision === 'acted').length;
  const quiet = today.filter((run) => run.decision === 'no_action').length;
  const openLedger = ledgerRows(sessions, 'open');
  const settledLedger = ledgerRows(sessions, 'settled');
  const supervised = sessions.filter((row) => row.supervised);
  const nextCheck = supervised.length === 0 ? 0 : Math.min(...supervised.map((row) => row.nextCheckAt).filter((at) => at > 0));
  const now = snapshot?.now ?? Date.now();

  const chips = (options: Array<{ value: string; label: string; count?: number }>, current: string, onPick: (value: string) => void): ReactElement =>
    React.createElement('div', { className: 'da-row', style: { gap: '6px' } },
      ...options.map((option) => React.createElement('button', {
        key: option.value === '' ? 'all' : option.value,
        className: current === option.value ? 'da-chip active' : 'da-chip',
        onClick: () => onPick(option.value),
      }, option.count === undefined ? option.label : `${option.label} ${option.count}`)),
    );

  const runRow = (run: { id: string; sessionId: string; trigger: string; status: string; decision?: string; reason?: string; note?: string; startedAt: string }, opts: { showDay: boolean }): ReactElement =>
    React.createElement('div', { className: 'da-item', key: `${run.sessionId}:${run.id}` },
      React.createElement('span', { className: 'da-item-time' }, fmtTime(Date.parse(run.startedAt))),
      React.createElement('span', { className: `da-tag ${outcomeTone(run.decision ?? run.status)}` }, outcomeLabel(run.decision ?? run.status)),
      React.createElement('span', { className: 'da-tag' }, triggerLabel(run.trigger)),
      React.createElement('span', { className: 'da-item-text' }, run.reason ?? run.note ?? '没留下理由'),
      React.createElement('span', { className: 'da-meta' }, opts.showDay ? shortId(run.sessionId) : shortId(run.sessionId)),
    );

  const header = (): ReactElement =>
    React.createElement('div', { className: 'da-head' },
      React.createElement('div', { className: 'da-head-row' },
        React.createElement('span', { className: 'da-h1' }, '自主意识'),
        React.createElement('span', { className: config?.enabled === true ? 'da-tag good' : 'da-tag' }, config?.enabled === true ? '在岗' : '休息'),
        React.createElement('span', { className: 'da-meta' }, `今天 ${today.length} 次判断 · 动手 ${acted} · 安静 ${quiet}`),
        React.createElement('span', { className: 'da-spacer' }),
        React.createElement('span', { className: 'da-meta' }, '字号'),
        React.createElement('select', {
          className: 'da-select',
          value: String(scale),
          title: '这一页的字号，只影响面板，不改宿主设置',
          onChange: (event: { target: { value: string } }) => pickScale(Number(event.target.value)),
        }, ...SCALE_STEPS.map((step) => React.createElement('option', { key: step.value, value: String(step.value) }, step.label))),
        React.createElement('button', { className: 'da-btn', disabled: busy, onClick: () => void pull() }, '刷新'),
        React.createElement('button', {
          className: 'da-btn primary',
          disabled: busy || targetSession === '',
          title: targetSession === '' ? '还没有可唤醒的会话' : `唤 ${shortId(targetSession)}`,
          onClick: () => void act({ type: 'wake' }, targetSession),
        }, '现在判断一次'),
      ),
      React.createElement('div', { className: 'da-sub' },
        `宿主按节律掷骰，醒来之后由她自己决定动手、说话还是继续睡。下一次掷骰 ${nextCheck > 0 ? fmtDelta(nextCheck, now) : '未安排'}（${fmtTime(nextCheck)}）。`,
      ),
      React.createElement('div', { className: 'da-tabs' },
        ...TABS.map((entry) => React.createElement('button', {
          key: entry.id,
          className: tab === entry.id ? 'da-tab active' : 'da-tab',
          onClick: () => setTab(entry.id),
        }, entry.label)),
      ),
    );

  if (snapshot === null) {
    return React.createElement('div', { className: 'da-surface da-page', style: { zoom: scale } },
      header(),
      React.createElement('div', { className: 'da-body' },
        React.createElement('div', { className: 'da-empty' }, error === null ? '载入中…' : `读取失败：${error}`)),
    );
  }

  const overview = (): ReactElement =>
    React.createElement('div', { className: 'da-body' },
      React.createElement('div', { className: 'da-cards' },
        React.createElement('div', { className: 'da-card' },
          React.createElement('span', { className: 'da-card-label' }, '今天的判断'),
          React.createElement('span', { className: 'da-card-value' }, String(today.length)),
          React.createElement('span', { className: 'da-card-note' }, `动手 ${acted} · 安静收着 ${quiet}`)),
        React.createElement('div', { className: 'da-card' },
          React.createElement('span', { className: 'da-card-label' }, '未完成的意图'),
          React.createElement('span', { className: 'da-card-value' }, String(openLedger.length)),
          React.createElement('span', { className: 'da-card-note' }, openLedger.length === 0 ? '账本干净' : '醒来时会按分数排序进提示')),
        React.createElement('div', { className: 'da-card' },
          React.createElement('span', { className: 'da-card-label' }, '下一次掷骰'),
          React.createElement('span', { className: 'da-card-value' }, nextCheck > 0 ? fmtDelta(nextCheck, now) : '未安排'),
          React.createElement('span', { className: 'da-card-note' }, fmtTime(nextCheck))),
        React.createElement('div', { className: 'da-card' },
          React.createElement('span', { className: 'da-card-label' }, '唤醒落点'),
          React.createElement('span', { className: 'da-card-value', style: { fontSize: '15px' } }, targetSession === '' ? '未设置' : shortId(targetSession)),
          React.createElement('span', { className: 'da-card-note' }, (config?.speakTargets ?? []).length === 0 ? '没有说话去处' : `说过的去处 ${(config?.speakTargets ?? []).length} 个`)),
      ),
      React.createElement('div', { className: 'da-section' },
        React.createElement('div', { className: 'da-section-head' },
          React.createElement('span', { className: 'da-section-title' }, '今天的判断'),
          React.createElement('span', { className: 'da-meta' }, `按 ${snapshot.timeZone} 的今天`),
          React.createElement('span', { className: 'da-spacer' }),
          React.createElement('button', { className: 'da-btn small', onClick: () => setTab('runs') }, '全部记录')),
        today.length === 0
          ? React.createElement('div', { className: 'da-empty' }, '今天还没有判断记录。')
          : React.createElement('div', { className: 'da-list' }, ...today.slice(0, 12).map((run) => runRow(run, { showDay: false }))),
      ),
    );

  const runsTab = (): ReactElement =>
    React.createElement('div', { className: 'da-body' },
      React.createElement('div', { className: 'da-filters' },
        chips([
          { value: '', label: '全部触发' },
          { value: 'random', label: '掷骰', count: runs?.triggers['random'] },
          { value: 'self', label: '自排', count: runs?.triggers['self'] },
          { value: 'manual', label: '手动', count: runs?.triggers['manual'] },
        ], query.trigger, (value) => setQuery((current) => ({ ...current, trigger: value, page: 0 }))),
        React.createElement('span', { style: { width: '10px' } }),
        chips([
          { value: '', label: '全部结果' },
          { value: 'acted', label: '动手', count: runs?.outcomes['acted'] },
          { value: 'no_action', label: '安静', count: runs?.outcomes['no_action'] },
          { value: 'busy', label: '正忙', count: runs?.outcomes['busy'] },
        ], query.outcome, (value) => setQuery((current) => ({ ...current, outcome: value, page: 0 }))),
      ),
      React.createElement('div', { className: 'da-row' },
        React.createElement('select', {
          className: 'da-select',
          value: query.session,
          onChange: (event: { target: { value: string } }) => setQuery((current) => ({ ...current, session: event.target.value, page: 0 })),
        },
        React.createElement('option', { value: '' }, '所有会话'),
        ...sessions.map((row) => React.createElement('option', { key: row.sessionId, value: row.sessionId }, `${shortId(row.sessionId)}${row.supervised ? ' · 受管' : ''}`))),
        React.createElement('input', {
          className: 'da-input',
          style: { flex: 1, minWidth: '220px' },
          placeholder: '搜理由里的字…',
          value: query.q,
          onChange: (event: { target: { value: string } }) => setQuery((current) => ({ ...current, q: event.target.value, page: 0 })),
        }),
        React.createElement('select', {
          className: 'da-select',
          value: String(query.limit),
          onChange: (event: { target: { value: string } }) => setQuery((current) => ({ ...current, limit: Number(event.target.value), page: 0 })),
        },
        React.createElement('option', { value: '20' }, '每页 20'),
        React.createElement('option', { value: '50' }, '每页 50'),
        React.createElement('option', { value: '100' }, '每页 100')),
      ),
      runsError === null ? null : React.createElement('div', { className: 'da-err' }, `记录读取失败：${runsError}`),
      runs === null
        ? React.createElement('div', { className: 'da-empty' }, '载入中…')
        : runs.rows.length === 0
          ? React.createElement('div', { className: 'da-empty' }, '没有符合筛选的记录。')
          : React.createElement('div', { className: 'da-list' }, ...runs.rows.map((run) => runRow(run, { showDay: true }))),
      runs === null
        ? null
        : React.createElement('div', { className: 'da-pager' },
          React.createElement('span', {}, `共 ${runs.total} 条 · 第 ${Math.min(query.page + 1, pageCount(runs.total, runs.limit))} / ${pageCount(runs.total, runs.limit)} 页`),
          React.createElement('button', {
            className: 'da-btn small',
            disabled: query.page <= 0,
            onClick: () => setQuery((current) => ({ ...current, page: Math.max(current.page - 1, 0) })),
          }, '上一页'),
          React.createElement('button', {
            className: 'da-btn small',
            disabled: (query.page + 1) * runs.limit >= runs.total,
            onClick: () => setQuery((current) => ({ ...current, page: current.page + 1 })),
          }, '下一页'),
        ),
    );

  const outboxRows = snapshot?.outbox ?? [];
  const outboxSection = (): ReactElement | null => {
    if (outboxRows.length === 0) return null;
    return React.createElement('div', { className: 'da-section' },
      React.createElement('div', { className: 'da-section-head' },
        React.createElement('span', { className: 'da-section-title' }, `待发的话（${outboxRows.filter((item) => item.status === 'pending').length}）`),
        React.createElement('span', { className: 'da-meta' }, '当时发不出去、她自己选排队的；目标一空就发，过期作废'),
      ),
      React.createElement('div', { className: 'da-list' }, ...outboxRows.map((item) => React.createElement('div', { className: 'da-item', key: item.id },
        React.createElement('span', { className: item.status === 'pending' ? 'da-tag good' : 'da-tag' }, outboxTag(item.status)),
        React.createElement('span', { className: 'da-item-text' }, item.text),
        React.createElement('span', { className: 'da-meta' }, item.target === '' ? '主人私聊' : item.target),
        React.createElement('span', { className: 'da-meta' }, item.status === 'pending' ? `至 ${fmtTime(item.expiresAt)}` : fmtTime(item.createdAt)),
      ))),
    );
  };

  const ledgerTab = (): ReactElement =>
    React.createElement('div', { className: 'da-body' },
      outboxSection(),
      React.createElement('div', { className: 'da-section' },
        React.createElement('div', { className: 'da-section-head' },
          React.createElement('span', { className: 'da-section-title' }, `未完成（${openLedger.length}）`),
          React.createElement('span', { className: 'da-meta' }, '醒来时按固定公式排序，低于门槛的不进提示但一直开着'),
        ),
        React.createElement('div', { className: 'da-row' },
          React.createElement('input', {
            className: 'da-input',
            style: { flex: 1, minWidth: '220px' },
            placeholder: '往账本里记一条…',
            id: 'da-new-intent',
          }),
          React.createElement('button', {
            className: 'da-btn',
            disabled: busy || targetSession === '',
            onClick: () => {
              const node = document.getElementById('da-new-intent') as HTMLInputElement | null;
              const text = node?.value.trim() ?? '';
              if (text === '') return;
              void act({ type: 'intent-create', text, kind: 'thought' }, targetSession).then(() => {
                if (node !== null) node.value = '';
              });
            },
          }, '记下'),
        ),
        openLedger.length === 0
          ? React.createElement('div', { className: 'da-empty' }, '没有未完成的意图。')
          : React.createElement('div', { className: 'da-list' }, ...openLedger.map((intent) => React.createElement('div', { className: 'da-item', key: intent.id },
            React.createElement('span', { className: 'da-tag' }, intent.kind === 'agreement' ? '约定' : '想法'),
            React.createElement('span', { className: 'da-item-text' }, intent.text,
              intent.dueAt === undefined ? null : React.createElement('span', { className: 'da-hint' }, ` · 到期 ${fmtTime(Date.parse(intent.dueAt))}`),
              intent.parkedUntil === undefined || Date.parse(intent.parkedUntil) <= Date.now()
                ? null
                : React.createElement('span', { className: 'da-hint', title: `连着 ${intent.chill ?? 0} 格没动手` }, ` · 暂停到 ${fmtTime(Date.parse(intent.parkedUntil))}`)),
            React.createElement('span', { className: 'da-meta' }, shortId(intent.sessionId)),
            React.createElement('button', {
              className: 'da-btn small',
              disabled: busy,
              onClick: () => void act({ type: 'intent-settle', id: intent.id, state: 'done', version: intent.version }, intent.sessionId),
            }, '完成'),
            React.createElement('button', {
              className: 'da-btn small danger',
              disabled: busy,
              onClick: () => void act({ type: 'intent-settle', id: intent.id, state: 'abandoned', version: intent.version }, intent.sessionId),
            }, '放弃'),
          ))),
      ),
      React.createElement('div', { className: 'da-section' },
        React.createElement('div', { className: 'da-section-head' },
          React.createElement('span', { className: 'da-section-title' }, `已收尾（${settledLedger.length}）`),
        ),
        settledLedger.length === 0
          ? React.createElement('div', { className: 'da-empty' }, '还没有收尾过的意图。')
          : React.createElement('div', { className: 'da-list' }, ...settledLedger.slice(0, 40).map((intent) => React.createElement('div', { className: 'da-item', key: `${intent.sessionId}:${intent.id}` },
            React.createElement('span', { className: `da-tag ${intent.state === 'done' ? 'good' : ''}` }, intent.state === 'done' ? '完成' : intent.state === 'abandoned' ? '放弃' : intent.state),
            React.createElement('span', { className: 'da-item-text' }, intent.text),
            React.createElement('span', { className: 'da-meta' }, shortId(intent.sessionId)),
          ))),
      ),
    );

  const scheduleTab = (): ReactElement =>
    React.createElement('div', { className: 'da-body' },
      React.createElement('div', { className: 'da-section-head' },
        React.createElement('span', { className: 'da-section-title' }, `受管会话（${supervised.length}）`),
        React.createElement('span', { className: 'da-spacer' }),
        React.createElement('button', {
          className: 'da-btn small',
          disabled: busy,
          onClick: () => void act({ type: 'create-wake-session' }),
        }, '建一个她自己的会话'),
      ),
      supervised.length === 0
        ? React.createElement('div', { className: 'da-empty' }, '还没有受管会话：填一个唤醒落点，或建一个她自己的会话。')
        : React.createElement('div', { className: 'da-sched' }, ...supervised.map((row) => React.createElement('div', { className: 'da-sched-row', key: row.sessionId },
          React.createElement('div', { className: 'da-sched-top' },
            React.createElement('span', { className: 'da-sched-id' }, shortId(row.sessionId)),
            React.createElement('span', { className: row.live ? 'da-tag good' : 'da-tag' }, row.live ? '在线' : '冷会话'),
            row.selfWake === null ? null : React.createElement('span', { className: 'da-tag' }, `自排 ${fmtTime(row.selfWake.at)}`),
            React.createElement('span', { className: 'da-spacer' }),
            React.createElement('button', { className: 'da-btn small', disabled: busy, onClick: () => void act({ type: 'wake' }, row.sessionId) }, '判断一次'),
            React.createElement('button', { className: 'da-btn small', disabled: busy || row.selfWake === null, onClick: () => void act({ type: 'cancel-self' }, row.sessionId) }, '取消自排'),
            React.createElement('button', { className: 'da-btn small danger', disabled: busy, onClick: () => void act({ type: 'stop' }, row.sessionId) }, '结束排队'),
          ),
          React.createElement('div', { className: 'da-sched-facts' },
            React.createElement('span', {}, `下次掷骰 ${fmtTime(row.nextCheckAt)}`),
            React.createElement('span', {}, `上次活动 ${fmtTime(row.lastActivityAt)}`),
            React.createElement('span', {}, `未完成意图 ${row.openIntents.length}`),
            row.lastSelfWake === null ? null : React.createElement('span', {}, `最近自排 ${fmtTime(row.lastSelfWake.at)} → ${fmtTime(row.lastSelfWake.firedAt)}`),
          ),
        ))),
    );

  const configTab = (): ReactElement =>
    React.createElement('div', { className: 'da-body' },
      React.createElement('div', { className: 'da-section' },
        React.createElement('div', { className: 'da-section-head' },
          React.createElement('span', { className: 'da-section-title' }, '配置'),
          React.createElement('span', { className: 'da-meta' }, `数据目录 ${snapshot.dataDir} · 时区 ${snapshot.timeZone}`),
        ),
        React.createElement(ConfigForm, {
          config: snapshot.config,
          disabled: busy,
          onSave: async (patch: Record<string, unknown>) => {
            await act({ type: 'configure', patch });
          },
        }),
        React.createElement('div', { className: 'da-hint' }, '这里和设置页改的是同一份配置；顺手存一下不会重排别的东西。'),
      ),
      React.createElement('div', { className: 'da-section' },
        React.createElement('div', { className: 'da-section-head' }, React.createElement('span', { className: 'da-section-title' }, '按一份配置直接改')),
        React.createElement('div', { className: 'da-row' },
          React.createElement('button', {
            className: 'da-btn',
            disabled: busy,
            onClick: () => {
              const next: Record<string, unknown> = buildPatch({ enabled: snapshot.config.enabled ? 'false' : 'true' });
              void act({ type: 'configure', patch: next });
            },
          }, snapshot.config.enabled ? '先停下她' : '让她上岗'),
        ),
      ),
    );

  const body = tab === 'overview' ? overview() : tab === 'runs' ? runsTab() : tab === 'ledger' ? ledgerTab() : tab === 'schedule' ? scheduleTab() : configTab();

  return React.createElement('div', { className: 'da-surface da-page', style: { zoom: scale } },
    header(),
    error === null ? null : React.createElement('div', { className: 'da-err', style: { padding: '0 22px 8px' } }, error),
    body,
  );
}
