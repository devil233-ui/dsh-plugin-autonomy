#!/usr/bin/env node
/**
 * 把私人日记里许下的愿望接进自主意识的台账（intents）。
 *
 * 日记（aurabot 模块 local-diary）每天 23:30 写一篇，愿望存在
 * modules-data/local-diary/index.json 的 wishes 数组里；它自己没有任何状态，
 * 写完就没人管了。这个脚本把还没进过台账的愿望挂到自主意识插件的意图账上，
 * 她每次自主醒来时都会在 prompt 里看到自己的意图，可以自己挑一条去做、
 * 或判断完就安静结束。
 *
 * 用法：
 *   node scripts/sync-diary-wishes.mjs              # 真写
 *   node scripts/sync-diary-wishes.mjs --dry-run    # 只看会写哪几条
 *   node scripts/sync-diary-wishes.mjs --days 7     # 只扫最近 7 天（默认全扫）
 *
 * 环境变量：
 *   AUTONOMY_URL          默认 http://10.8.0.10:3301
 *   AUTONOMY_SESSION_ID   默认读 /root/.dsh/autonomy/config.json 的 wakeSession
 *   DIARY_INDEX           默认 /root/.dsh/plugins-data/aurabot/modules-data/local-diary/index.json
 */
import { readFileSync } from 'node:fs'

const BASE = process.env.AUTONOMY_URL || 'http://10.8.0.10:3301'
const DIARY_INDEX =
  process.env.DIARY_INDEX || '/root/.dsh/plugins-data/aurabot/modules-data/local-diary/index.json'
const CONFIG = '/root/.dsh/autonomy/config.json'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const daysArg = args.indexOf('--days')
const days = daysArg >= 0 ? Number(args[daysArg + 1]) : 0

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[「」『』“”"'，,。.、；;：:！!？?（）()【】\[\]…—\-·]/g, '')
}

/** 同一件事换个说法也算重复：任一方的归一化文本包含另一方即可。 */
function looksSame(a, b) {
  const x = normalize(a)
  const y = normalize(b)
  if (x === '' || y === '') return false
  if (x === y) return true
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return short.length >= 6 && long.includes(short)
}

function collectWishes(index) {
  const cutoff = days > 0 ? Date.now() - days * 86400000 : 0
  const out = []
  for (const row of index) {
    const at = Number(row.at) || 0
    if (cutoff && at < cutoff) continue
    const list = Array.isArray(row.wishes) ? row.wishes : row.wish ? String(row.wish).split('；') : []
    for (const raw of list) {
      const text = String(raw || '').trim()
      if (text !== '') out.push({ day: row.day, text })
    }
  }
  return out
}

async function getLedger(sessionId) {
  const url = `${BASE}/api/dsh-autonomy/state?session=${encodeURIComponent(sessionId)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`GET state 失败：HTTP ${res.status}`)
  const data = await res.json()
  // 快照里的 sessions 是数组，台账按 sessionId 取那一行；早期版本误读成顶层 openIntents，
  // 结果去重形同虚设、同一条愿望被导入两次（2026-11-23 实修过）。
  const rows = Array.isArray(data.sessions) ? data.sessions : []
  const row = rows.find((item) => String(item?.sessionId || '') === sessionId) || {}
  const open = Array.isArray(row.openIntents) ? row.openIntents : []
  const settled = Array.isArray(row.settledIntents) ? row.settledIntents : []
  return { open, settled }
}

async function createIntent(sessionId, text) {
  const url = `${BASE}/api/dsh-autonomy/action?session=${encodeURIComponent(sessionId)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'intent-create', text, kind: 'thought' }),
    signal: AbortSignal.timeout(8000),
  })
  const payload = await res.text()
  if (!res.ok) throw new Error(`POST action 失败：HTTP ${res.status} ${payload.slice(0, 160)}`)
  return payload
}

async function main() {
  const config = readJson(CONFIG)
  const sessionId = process.env.AUTONOMY_SESSION_ID || String(config.wakeSession || '').trim()
  if (sessionId === '') throw new Error('没有 wakeSession，也不在 AUTONOMY_SESSION_ID 里给')

  const wishes = collectWishes(readJson(DIARY_INDEX))
  if (wishes.length === 0) {
    console.log('日记里没有愿望，什么都不做。')
    return
  }

  const { open, settled } = await getLedger(sessionId)
  const existing = [...open, ...settled].map((intent) => String(intent.text || ''))
  const imported = []
  const skipped = []

  for (const wish of wishes) {
    if (existing.some((text) => looksSame(text, wish.text))) {
      skipped.push(wish)
      continue
    }
    if (!dryRun) await createIntent(sessionId, wish.text)
    existing.push(wish.text)
    imported.push(wish)
  }

  const tag = dryRun ? '（试运行，没有写入）' : ''
  console.log(`台账会话 ${sessionId}，现有 ${open.length} 条开着${tag}`)
  for (const wish of imported) console.log(`  + ${wish.day} ${wish.text}`)
  for (const wish of skipped) console.log(`  = ${wish.day} ${wish.text}（台账里已有）`)
  console.log(`新增 ${imported.length} 条，跳过 ${skipped.length} 条。`)
}

main().catch((error) => {
  console.error(`同步失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
