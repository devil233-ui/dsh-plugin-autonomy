#!/usr/bin/env node
/**
 * 把私人日记里许下的愿望接进自主意识的「愿望」栏（不是待办）。
 *
 * 日记（aurabot 模块 local-diary）每天 23:30 写一篇，愿望存在
 * modules-data/local-diary/index.json 的 wishes 数组里；它自己没有任何状态，
 * 写完就没人管了。这个脚本把它们记进自主意识插件的愿望栏（`wishes.json`），
 * 每条带上日记日期与原文路径；她每次自主醒来会单独看到这些愿望，想回看原文
 * 就照路径去读。愿望不进意图台账——那不是待办。
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

function collectWishes(index) {
  const cutoff = days > 0 ? Date.now() - days * 86400000 : 0
  const out = []
  for (const row of index) {
    const at = Number(row.at) || 0
    if (cutoff && at < cutoff) continue
    const list = Array.isArray(row.wishes) ? row.wishes : row.wish ? String(row.wish).split('；') : []
    for (const raw of list) {
      const text = String(raw || '').trim()
      if (text !== '') out.push({ day: String(row.day || ''), text, source: String(row.file || '') })
    }
  }
  return out
}

async function createWish(wish) {
  const url = `${BASE}/api/dsh-autonomy/action?session=${encodeURIComponent(sessionId)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'wish-create', text: wish.text, day: wish.day, source: wish.source }),
    signal: AbortSignal.timeout(8000),
  })
  const payload = await res.text()
  if (res.ok) return 'created'
  // 插件侧按归一化文本去重，重复的会以这句报错回绝，不算失败。
  if (payload.includes('已经记过')) return 'duplicate'
  throw new Error(`POST action 失败：HTTP ${res.status} ${payload.slice(0, 160)}`)
}

async function main() {
  const wishes = collectWishes(readJson(DIARY_INDEX))
  if (wishes.length === 0) {
    console.log('日记里没有愿望，什么都不做。')
    return
  }

  const imported = []
  const skipped = []

  for (const wish of wishes) {
    if (!dryRun) {
      const state = await createWish(wish)
      if (state === 'duplicate') {
        skipped.push(wish)
        continue
      }
    }
    imported.push(wish)
  }

  const tag = dryRun ? '（试运行，没有写入）' : ''
  console.log(`愿望栏${tag}`)
  for (const wish of imported) console.log(`  + ${wish.day} ${wish.text}`)
  for (const wish of skipped) console.log(`  = ${wish.day} ${wish.text}（愿望栏里已有）`)
  console.log(`新增 ${imported.length} 条，跳过 ${skipped.length} 条。`)
}

main().catch((error) => {
  console.error(`同步失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
