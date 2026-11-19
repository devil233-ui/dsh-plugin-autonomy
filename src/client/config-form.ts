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

type FieldKind = 'number' | 'text' | 'list' | 'bool';

interface FieldSpec {
  key: keyof ConfigView;
  label: string;
  hint?: string;
  kind: FieldKind;
  step?: string;
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
      { key: 'wakeSession', label: '唤醒落点', hint: '留空 = 按下面的目标会话列表', kind: 'text' },
      { key: 'sessions', label: '目标会话', hint: '留空 = 全部根会话；落点非空时忽略', kind: 'list' },
    ],
  },
  {
    title: '说话与打分',
    fields: [
      { key: 'speakTargets', label: '许她发消息的去处', hint: '一个都不填 = 她不许往外发；地址写成 group:群号 或 private:QQ号，逗号分隔', kind: 'list' },
      { key: 'scoreEnabled', label: '唤醒时给意图打分', kind: 'bool' },
      { key: 'scoreThreshold', label: '打分门槛（0-1）', kind: 'number', step: '0.05' },
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
        React.createElement('span', { className: 'da-label' }, spec.label),
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
