/**
 * Deterministic candidate scoring.
 *
 * A wake used to hand the model an unordered list of open intents and hope it
 * picked the right one. This module turns that list into numbers the model can
 * audit: how the clock stands, whether it is a repeat of something already
 * handled, where the item came from, and how firmly she committed to it.
 *
 * Nothing here calls a model and nothing here is random, so the same state plus
 * the same clock always yields the same ranking. That property is the whole
 * point: a score the operator cannot recompute is a vibe, not a judgement.
 */

export type CandidateKind = 'thought' | 'agreement' | 'self';

export type CandidateSource = 'owner' | 'conversation' | 'self' | 'unknown';

export interface Candidate {
  readonly id: string;
  readonly text: string;
  readonly kind: CandidateKind;
  readonly dueAt?: string;
  readonly preferredAt?: string;
  readonly source?: CandidateSource;
}

export interface ScoreParts {
  readonly urgency: number;
  readonly novelty: number;
  readonly relevance: number;
  readonly commitment: number;
}

export interface ScoredCandidate extends Candidate {
  readonly score: number;
  readonly parts: ScoreParts;
}

export interface ScoreContext {
  readonly now: number;
  /** What she already did or already said, newest-last. Used for novelty only. */
  readonly recent?: readonly string[];
}

export const SCORE_WEIGHTS = {
  urgency: 0.4,
  novelty: 0.3,
  relevance: 0.2,
  commitment: 0.1,
} as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function parseAt(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** How the clock presses on this item. 1 = already late. */
export function urgencyOf(candidate: Candidate, now: number): number {
  const due = parseAt(candidate.dueAt);
  if (due !== undefined) {
    if (due <= now) return 1;
    if (due - now <= DAY_MS) return 0.75;
    return 0.3;
  }
  const preferred = parseAt(candidate.preferredAt);
  if (preferred !== undefined) {
    if (preferred <= now) return 0.6;
    if (preferred - now <= DAY_MS) return 0.45;
    return 0.25;
  }
  return 0.2;
}

/** Where it came from: the owner's own words outrank a note she left herself. */
export function relevanceOf(source: CandidateSource | undefined): number {
  switch (source ?? 'unknown') {
    case 'owner':
      return 1;
    case 'conversation':
      return 0.8;
    case 'self':
      return 0.5;
    default:
      return 0.6;
  }
}

/** How firmly she committed to it when she wrote it down. */
export function commitmentOf(kind: CandidateKind): number {
  switch (kind) {
    case 'agreement':
      return 1;
    case 'self':
      return 0.7;
    default:
      return 0.5;
  }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** Stable 32-bit FNV-1a over the normalized text: a cheap dedupe key. */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (const ch of normalize(text)) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function bigrams(text: string): Set<string> {
  const chars = Array.from(normalize(text));
  const out = new Set<string>();
  for (let index = 0; index + 1 < chars.length; index += 1) out.add(chars[index] + chars[index + 1]);
  if (chars.length === 1) out.add(chars[0] as string);
  return out;
}

/** Jaccard overlap over character bigrams; 0 when either side is empty. */
export function overlap(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** 1 = unlike anything she already touched; 0 = a near repeat of it. */
export function noveltyOf(text: string, recent: readonly string[]): number {
  let worst = 0;
  for (const other of recent) worst = Math.max(worst, overlap(text, other));
  return round(1 - worst);
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

export function scoreCandidate(candidate: Candidate, context: ScoreContext): ScoredCandidate {
  const parts: ScoreParts = {
    urgency: urgencyOf(candidate, context.now),
    novelty: noveltyOf(candidate.text, context.recent ?? []),
    relevance: relevanceOf(candidate.source),
    commitment: commitmentOf(candidate.kind),
  };
  const score = round(
    parts.urgency * SCORE_WEIGHTS.urgency +
      parts.novelty * SCORE_WEIGHTS.novelty +
      parts.relevance * SCORE_WEIGHTS.relevance +
      parts.commitment * SCORE_WEIGHTS.commitment,
  );
  return { ...candidate, score, parts };
}

/** Highest score first; ties fall back to the earlier deadline, then the id. */
export function rankCandidates(candidates: readonly Candidate[], context: ScoreContext): ScoredCandidate[] {
  return candidates
    .map((candidate) => scoreCandidate(candidate, context))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const left = parseAt(a.dueAt ?? a.preferredAt);
      const right = parseAt(b.dueAt ?? b.preferredAt);
      if (left !== right) return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER);
      return a.id.localeCompare(b.id);
    });
}

export interface SelectOptions {
  /** Score below this stays off the prompt; the intents themselves stay open. */
  readonly threshold: number;
  /** Cap on how many scored items get rendered, so the prompt stays cheap. */
  readonly max: number;
}

export function selectCandidates(
  scored: readonly ScoredCandidate[],
  options: SelectOptions,
): ScoredCandidate[] {
  return scored.filter((entry) => entry.score >= options.threshold).slice(0, Math.max(0, options.max));
}

function humanGap(gapMs: number): string {
  const minutes = Math.round(Math.abs(gapMs) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Short, plain-language account of why this item scored where it did. */
export function explain(scored: ScoredCandidate, now: number): string {
  const notes: string[] = [];
  const due = parseAt(scored.dueAt);
  const preferred = parseAt(scored.preferredAt);
  if (due !== undefined) {
    notes.push(due <= now ? `overdue by ${humanGap(now - due)}` : `due in ${humanGap(due - now)}`);
  } else if (preferred !== undefined) {
    notes.push(preferred <= now ? `wanted since ${humanGap(now - preferred)} ago` : `wanted in ${humanGap(preferred - now)}`);
  } else {
    notes.push('no deadline');
  }
  if (scored.parts.novelty >= 0.8) notes.push('new');
  else if (scored.parts.novelty <= 0.3) notes.push('close to something already handled');
  if (scored.source === 'owner' || scored.source === 'conversation') notes.push('came from a real conversation');
  if (scored.kind === 'agreement') notes.push('a promise to someone');
  return notes.join('; ');
}
