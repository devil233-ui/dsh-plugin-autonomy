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
 * 三个位置都必须显式给，脚本不带任何默认路径（它跑在谁家的机器上都一样）：
 *
 *   node scripts/sync-diary-wishes.mjs \
 *     --url http://127.0.0.1:3301 \
 *     --session session-xxxxxxxx-.... \
 *     --diary /path/to/aurabot/modules-data/local-diary/index.json \
 *     [--dry-run] [--days N]
 *
 * 对应的环境变量：AUTONOMY_URL / AUTONOMY_SESSION_ID / DIARY_INDEX（参数优先）。
 * --session 一般填自主意识配置里的 wakeSession（$DSH_HOME/autonomy/config.json）。
 */
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)

function flag(name) {
  return args.includes(name)
}

function option(name) {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

function required(what, value) {
  const text = String(value ?? '').trim()
  if (text === '') {
    throw new Error(`缺少 ${what}：用命令行参数给，或用对应环境变量（见文件头用法）`)
  }
  return text
}

const dryRun = flag('--dry-run')
const daysArg = option('--days')
const days = daysArg === undefined ? 0 : Number(daysArg)
if (Number.isNaN(days) || days < 0) throw new Error(`--days 要给正数，收到 ${daysArg}`)

const BASE = required('--url', option('--url') ?? process.env.AUTONOMY_URL).replace(/\/+$/, '')
const sessionId = required('--session', option('--session') ?? process.env.AUTONOMY_SESSION_ID)
const DIARY_INDEX = required('--diary', option('--diary') ?? process.env.DIARY_INDEX)

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

async function getLedger() {
  const url = `${BASE}/api/dsh-autonomy/state?session=${encodeURIComponent(sessionId)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`GET state 失败：HTTP ${res.status}`)
  const data = await res.json()
  // 快照里的 sessions 是数组，台账按 sessionId 取那一行；早期版本误读成顶层 openIntents，
  // 结果去重形同虚设、同一条愿望被导入两次。
  const rows = Array.isArray(data.sessions) ? data.sessions : []
  const row = rows.find((item) => String(item?.sessionId || '') === sessionId) || {}
  const open = Array.isArray(row.openIntents) ? row.openIntents : []
  const settled = Array.isArray(row.settledIntents) ? row.settledIntents : []
  return { open, settled }
}

async function createIntent(text) {
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
  const wishes = collectWishes(readJson(DIARY_INDEX))
  if (wishes.length === 0) {
    console.log('日记里没有愿望，什么都不做。')
    return
  }

  const { open, settled } = await getLedger()
  const existing = [...open, ...settled].map((intent) => String(intent.text || ''))
  const imported = []
  const skipped = []

  for (const wish of wishes) {
    if (existing.some((text) => looksSame(text, wish.text))) {
      skipped.push(wish)
      continue
    }
    if (!dryRun) await createIntent(wish.text)
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
