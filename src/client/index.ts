/**
 * Browser half of dsh-autonomy.
 *
 * Two surfaces, one data source:
 *  - a standalone page (main slot + sidebar row) like the built-in "自动化任务"
 *    panel: overview, judgement history with filters and paging, the intent
 *    ledger, the schedule, and the config form;
 *  - a small settings card that only shows status and jumps to that page, so
 *    the settings modal never has to scroll through lists again.
 *
 * Registering a slot is allowed to fail on a GUI without the matching seat; it
 * is logged, never thrown, so an external plugin cannot take the GUI down.
 */

import type { Context } from '@deepseek-ai/cordis';
import * as React from 'react';
import type { ReactElement } from 'react';

import { AutonomyIcon, AutonomyPage } from './page.js';
import {
  EVENTS_URL,
  PANEL_ID,
  STATE_URL,
  fmtDelta,
  fmtTime,
  getJson,
  injectStyle,
  postAction,
  shortId,
  type Snapshot,
} from './shared.js';

const NS = 'dsh-autonomy';

export const inject = ['slots', 'remote', 'connection', 'locale'];

interface SlotsLike {
  inject(name: string, factory: () => unknown): void;
  register(spec: Record<string, unknown>, component: (props: Record<string, unknown>) => ReactElement): () => void;
}

interface LayoutLike {
  selectPanel(panelId: string): void;
}

const h = React.createElement;

function AutonomyCard(props: { openPanel?: () => void }): ReactElement {
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

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

  const act = (body: Record<string, unknown>): void => {
    setBusy(true);
    void postAction(body)
      .then((next) => {
        setSnapshot(next);
        setError(null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  if (snapshot === null) {
    return h('div', { className: 'da-surface da-card-surface' },
      h('div', { className: 'da-section-head' }, h('span', { className: 'da-section-title' }, '自主意识')),
      error === null ? h('div', { className: 'da-hint' }, '载入中…') : h('div', { className: 'da-err' }, `读取失败：${error}`),
    );
  }

  const config = snapshot.config;
  const today = snapshot.todayRuns;
  const acted = today.filter((run) => run.decision === 'acted').length;
  const quiet = today.filter((run) => run.decision === 'no_action').length;
  const supervised = snapshot.sessions.filter((row) => row.supervised);
  const target = config.wakeSession.trim() !== ''
    ? config.wakeSession.trim()
    : (supervised[0]?.sessionId ?? snapshot.sessions[0]?.sessionId ?? '');
  const nextCheck = supervised.map((row) => row.nextCheckAt).filter((at) => at > 0);
  const soonest = nextCheck.length === 0 ? 0 : Math.min(...nextCheck);

  return h('div', { className: 'da-surface da-card-surface' },
    h('div', { className: 'da-section-head' },
      h('span', { className: 'da-section-title' }, '自主意识'),
      h('span', { className: config.enabled ? 'da-tag good' : 'da-tag' }, config.enabled ? '在岗' : '休息'),
      h('span', { className: 'da-spacer' }),
      h('span', { className: 'da-hint' }, target === '' ? '还没有落点' : `落点 ${shortId(target)}`),
    ),
    h('div', { className: 'da-hint' },
      `今天 ${today.length} 次判断 · 动手 ${acted} · 安静收着 ${quiet} · 下一次掷骰 ${soonest > 0 ? fmtDelta(soonest, snapshot.now) : '未安排'}（${fmtTime(soonest)}）`),
    h('div', { className: 'da-row' },
      h('button', { className: 'da-btn primary', onClick: () => props.openPanel?.() }, '打开面板'),
      h('button', {
        className: 'da-btn',
        disabled: busy || target === '',
        onClick: () => act({ type: 'wake', sessionId: target }),
      }, '现在判断一次'),
      h('button', {
        className: 'da-btn',
        disabled: busy,
        onClick: () => act({ type: 'configure', patch: { enabled: !config.enabled } }),
      }, config.enabled ? '先停下她' : '让她上岗'),
      error === null ? null : h('span', { className: 'da-err' }, error),
    ),
    h('div', { className: 'da-hint' }, '节奏、睡眠窗、打分门槛、台账与全部判断记录都在左侧栏的「自主意识」页面里。'),
  );
}

export function apply(ctx: Context): void {
  injectStyle();
  const reader = ctx as unknown as { slots?: SlotsLike; get(name: string, strict?: boolean): unknown };
  const slots = reader.slots ?? (reader.get('slots', false) as SlotsLike | undefined);
  if (slots === undefined) {
    console.error('[dsh-autonomy] slots service unavailable; panel not mounted');
    return;
  }

  const openPanel = (): void => {
    try {
      const layout = reader.get('layout', false) as LayoutLike | undefined;
      layout?.selectPanel(PANEL_ID);
    } catch (error) {
      console.error('[dsh-autonomy] cannot open the panel from here', error);
    }
  };

  try {
    slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID, locale: NS }, () => h(AutonomyPage, {})));
  } catch (error) {
    console.error('[dsh-autonomy] main panel registration failed', error);
  }

  try {
    slots.inject('sidebar.panellist', () =>
      slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 60, locale: NS, label: () => '自主意识' },
        (props) => h(AutonomyIcon, {
          size: typeof props['size'] === 'number' ? props['size'] : 16,
          active: props['active'] === true,
        }),
      ),
    );
  } catch (error) {
    console.error('[dsh-autonomy] sidebar entry registration failed', error);
  }

  try {
    slots.inject('settings.section', () =>
      slots.register(
        { name: 'settings.section', id: 'dsh-autonomy', order: 130, locale: NS, label: () => 'Autonomy', inject: () => ({}) },
        () => h(AutonomyCard, { openPanel }),
      ),
    );
  } catch (error) {
    console.error('[dsh-autonomy] settings card registration failed', error);
  }
}
