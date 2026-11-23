/**
 * The one configuration form, shared by the settings card and the standalone
 * page so the two surfaces can never drift.
 *
 * Draft semantics: only fields the operator actually touched live in `draft`,
 * so an emptied box means "clear this" rather than "keep the old value".
 */

import * as React from 'react';
import type { ReactElement } from 'react';

import type { ConfigView } from './shared.js';

type FieldKind = 'number' | 'text' | 'list' | 'bool' | 'select';

interface FieldSpec {
  key: keyof ConfigView;
  label: string;
  hint?: string;
  kind: FieldKind;
  step?: string;
  /** kind='select' 时的候选项。 */
  options?: Array<{ value: string; label: string }>;
}

interface GroupSpec {
  title: string;
  fields: FieldSpec[];
}

export const CONFIG_GROUPS: GroupSpec[] = [
  {
    title: '节奏',
    fields: [
      { key: 'intervalMinutes', label: '平均间隔（分钟）', kind: 'number', step: '1' },
      { key: 'jitterRatio', label: '抖动比例', hint: '0.1 = ±10%', kind: 'number', step: '0.05' },
      { key: 'probability', label: '唤醒概率（0-1）', kind: 'number', step: '0.05' },
      { key: 'mode', label: '概率模式', hint: 'fixed / adaptive', kind: 'text' },
    ],
  },
  {
    title: '睡眠与名额',
    fields: [
      { key: 'sleepWindows', label: '睡眠时段', hint: 'HH:mm-HH:mm，多个用逗号分隔', kind: 'list' },
      { key: 'timezone', label: '时区', hint: '留空 = 宿主时区', kind: 'text' },
      { key: 'maxRunsPerDay', label: '每日上限', hint: '0 = 不限', kind: 'number', step: '1' },
      { key: 'minIdleMinutes', label: '最近活动后跳过（分钟）', kind: 'number', step: '1' },
      { key: 'allowSelfWake', label: '允许她自排唤醒', kind: 'bool' },
      { key: 'selfWakeDuringSleep', label: '睡眠时段也允许自排', kind: 'bool' },
    ],
  },
  {
    title: '唤醒落点与会话',
    fields: [
      { key: 'wakeSession', label: '唤醒落点（首选）', hint: '填了就只在这一条会话里醒，下面那栏完全不看', kind: 'text' },
      { key: 'wakeWorkspace', label: '房间所在工作区', hint: '工作区 id 或绝对路径（例如 /srv/agent-workspace）；留空=宿主默认', kind: 'text' },
      { key: 'wakeTitle', label: '房间标题', hint: '新建房间时用这个名字；留空=「自主意识 · 她的房间」', kind: 'text' },
      { key: 'sessions', label: '目标会话（落点为空时才用）', hint: '填了 = 只醒这几条；这栏也空 = 全部根会话（含 QQ 聊天，会打扰对话）', kind: 'list' },
    ],
  },
  {
    title: '说话与打分',
    fields: [
      { key: 'speakTargets', label: '许她发消息的去处', hint: '主人私聊始终能用，这栏只加别的去处；地址写成 group:群号 或 private:QQ号，逗号分隔', kind: 'list' },
      { key: 'speakCooldownMinutes', label: '同一聊天的发言间隔（分钟）', hint: '说过一次后这段时间内不再往同一处发；0 = 不管', kind: 'number', step: '1' },
      { key: 'scoreEnabled', label: '唤醒时给意图打分', kind: 'bool' },
      { key: 'scoreThreshold', label: '打分门槛（0-1）', kind: 'number', step: '0.05' },
      { key: 'moodEnabled', label: '按她的心情调制这一轮摆什么（不动节奏）', hint: '心情读自 dsh-aurabot-qq 的心情模块；没装它、或它没开心情模块，就跳过这一档，唤醒照常', kind: 'bool' },
    ],
  },
  {
    title: '复盘',
    fields: [
      { key: 'reviewEnabled', label: '攒够判断就复盘', hint: '把这一段的自检记录交给一次不带工具的回合蒸馏成教训；关掉就只留台账', kind: 'bool' },
      { key: 'reviewBatch', label: '攒够几条判断复盘一次', kind: 'number', step: '1' },
      { key: 'reviewMinGapMinutes', label: '两次复盘至少间隔（分钟）', kind: 'number', step: '10' },
      { key: 'reviewMaxInputTokens', label: '复盘输入预算（token）', hint: '按 2 字符≈1 token 粗估，超了从最旧的记录开始裁', kind: 'number', step: '256' },
      { key: 'reviewMaxOutputTokens', label: '复盘输出预算（token）', kind: 'number', step: '64' },
      { key: 'reviewWriteMemory', label: '复盘顺手写回记忆库', hint: '默认关：记忆库那边只开了召回，写要另一套接口', kind: 'bool' },
    ],
  },
  {
    title: '记忆召回',
    fields: [
      { key: 'recallSource', label: '醒来前查记忆库', kind: 'select', hint: 'off=不查；http=自己填一个兼容 /api/recall 的服务；aurabot=直接问 dsh-aurabot-qq 的记忆模块，不用填地址', options: [{ value: 'off', label: '不查' }, { value: 'http', label: 'HTTP 接口' }, { value: 'aurabot', label: 'dsh-aurabot-qq 记忆库' }] },
      { key: 'recallUrl', label: '召回接口', hint: '只在「HTTP 接口」时用：任何兼容 /api/recall 的服务都行（MemoryConstellations 是其中一种）', kind: 'text' },
      { key: 'recallLimit', label: '最多几条', kind: 'number', step: '1' },
      { key: 'recallTimeoutMs', label: '超时（毫秒）', hint: '查不到就跳过，不耽误这一轮', kind: 'number', step: '100' },
      { key: 'recallMaxChars', label: '最多塞多少字', kind: 'number', step: '50' },
    ],
  },
  {
    title: '其他',
    fields: [
      { key: 'motivation', label: '自主回合开场白', hint: '留空 = 内置', kind: 'text' },
      { key: 'enabled', label: '启用', kind: 'bool' },
    ],
  },
];

const ALL_FIELDS: Map<string, FieldSpec> = new Map(
  CONFIG_GROUPS.flatMap((group) => group.fields.map((field) => [String(field.key), field] as const)),
);

function display(config: ConfigView, key: keyof ConfigView): string {
  const raw = config[key] as unknown;
  if (Array.isArray(raw)) return raw.join(', ');
  return String(raw);
}

export function buildPatch(draft: Record<string, string>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(draft)) {
    const spec = ALL_FIELDS.get(key);
    if (spec === undefined) continue;
    if (spec.kind === 'bool') {
      patch[key] = raw === 'true';
      continue;
    }
    if (spec.kind === 'list') {
      patch[key] = raw.split(',').map((part) => part.trim()).filter((part) => part !== '');
      continue;
    }
    if (spec.kind === 'number') {
      const value = Number(raw);
      if (Number.isFinite(value)) patch[key] = value;
      continue;
    }
    patch[key] = raw.trim();
  }
  return patch;
}

export function ConfigForm(props: {
  config: ConfigView;
  disabled?: boolean;
  columns?: number;
  onSave: (patch: Record<string, unknown>) => Promise<void> | void;
}): ReactElement {
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const dirty = Object.keys(draft).length > 0;

  const touch = (key: string, value: string): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = (): void => {
    if (!dirty) return;
    setSaving(true);
    void Promise.resolve(props.onSave(buildPatch(draft)))
      .then(() => setDraft({}))
      .finally(() => setSaving(false));
  };

  const renderField = (spec: FieldSpec): ReactElement => {
    const key = String(spec.key);
    const current = draft[key];
    const value = current === undefined ? display(props.config, spec.key) : current;
    const disabled = props.disabled === true || saving;

    if (spec.kind === 'bool') {
      const checked = value === 'true';
      return React.createElement('label', { className: 'da-field', key },
        React.createElement('span', { className: 'da-label' }, spec.label, spec.hint === undefined ? null : React.createElement('span', { className: 'da-hint' }, ` · ${spec.hint}`)),
        React.createElement('span', { className: 'da-check' },
          React.createElement('input', {
            type: 'checkbox',
            checked,
            disabled,
            onChange: (event: { target: { checked: boolean } }) => touch(key, event.target.checked ? 'true' : 'false'),
          }),
          React.createElement('span', {}, checked ? '开' : '关'),
        ),
      );
    }

    if (spec.kind === 'select') {
      return React.createElement('label', { className: 'da-field', key },
        React.createElement('span', { className: 'da-label' }, spec.label, spec.hint === undefined ? null : React.createElement('span', { className: 'da-hint' }, ` · ${spec.hint}`)),
        React.createElement('select', {
          className: 'da-select',
          value,
          disabled,
          onChange: (event: { target: { value: string } }) => touch(key, event.target.value),
        }, ...(spec.options ?? []).map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label))),
      );
    }

    return React.createElement('label', { className: 'da-field', key },
      React.createElement('span', { className: 'da-label' }, spec.label, spec.hint === undefined ? null : React.createElement('span', { className: 'da-hint' }, ` · ${spec.hint}`)),
      React.createElement('input', {
        className: 'da-input',
        type: spec.kind === 'number' ? 'number' : 'text',
        step: spec.step,
        value,
        disabled,
        onChange: (event: { target: { value: string } }) => touch(key, event.target.value),
      }),
    );
  };

  return React.createElement('div', { className: 'da-card-surface' },
    ...CONFIG_GROUPS.map((group) => React.createElement('div', { className: 'da-section', key: group.title },
      React.createElement('div', { className: 'da-section-head' }, React.createElement('span', { className: 'da-section-title' }, group.title)),
      React.createElement('div', { className: 'da-grid' }, ...group.fields.map(renderField)),
    )),
    React.createElement('div', { className: 'da-row' },
      React.createElement('button', { className: 'da-btn primary', disabled: props.disabled === true || saving || !dirty, onClick: save }, dirty ? '保存配置' : '没有改动'),
      dirty
        ? React.createElement('button', { className: 'da-btn', disabled: saving, onClick: () => setDraft({}) }, '撤销修改')
        : null,
      React.createElement('span', { className: 'da-hint' }, '保存后立刻生效：节奏改动会重排下一次掷骰。'),
    ),
  );
}
