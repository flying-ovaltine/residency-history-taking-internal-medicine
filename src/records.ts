/**
 * 训练记录：只追加的 Markdown 表格，落在用户主目录下。
 *
 * 位置：`~/.workbuddy/history-taking-records.md`
 *   → 目录建不了 / 写不进去：退到会话工作目录的 `训练记录.md`
 *   → 还写不进去：静默降级，不报错、不中断考试，也不声称「已记录」
 *
 * 只追加、不改写旧行：一旦重排历史，累计就不可信了。统计一律在读的时候现算。
 */

import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 一轮考试的战绩。 */
export interface RecordRow {
  /** 日期时间，例如 2026-11-16 21:10。 */
  at: string
  /** 题号 1–32。 */
  caseNo: number
  /** 病种短名。 */
  disease: string
  /** 总分 0–100。 */
  score: number
  /** 判定：通过 / 临界 / 不通过。 */
  verdict: string
  /** 主要失分项，用顿号分隔。 */
  lost: string
  /** 用时（分钟），未知记 0。 */
  minutes: number
  /** 求助次数。 */
  help: number
}

/** 记录表头（文件不存在时先写这行）。 */
const HEADER = [
  '# 病史采集训练记录',
  '',
  '| 日期时间 | 题号 | 病种 | 总分 | 判定 | 主要失分项 | 用时 | 求助 |',
  '|---|---|---|---|---|---|---|---|',
  '',
].join('\n')

/** 记录文件路径候选，按优先级排列。 */
export function recordsPathCandidates(fallbackDir?: string): string[] {
  const paths = [join(homedir(), '.workbuddy', 'history-taking-records.md')]
  if (fallbackDir !== undefined && fallbackDir !== '') {
    paths.push(join(fallbackDir, '训练记录.md'))
  }
  return paths
}

/** 两位补零。 */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地时间戳，格式 YYYY-MM-DD HH:mm。 */
export function timestamp(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 从表格行里拆出单元格。 */
function cellsOf(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/** 解析记录文件里的全部战绩行（跳过表头与分隔行）。 */
export function parseRecords(text: string): RecordRow[] {
  const rows: RecordRow[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) continue
    const cells = cellsOf(line)
    if (cells.length < 4) continue
    if (/^-{2,}$/.test(cells[0] ?? '') || cells[0] === '日期时间') continue
    const caseNo = Number.parseInt(cells[1] ?? '', 10)
    const score = Number.parseFloat(cells[3] ?? '')
    if (!Number.isFinite(caseNo) || !Number.isFinite(score)) continue
    rows.push({
      at: cells[0] ?? '',
      caseNo,
      disease: cells[2] ?? '',
      score,
      verdict: cells[4] ?? '',
      lost: cells[5] ?? '',
      minutes: Number.parseInt(cells[6] ?? '', 10) || 0,
      help: Number.parseInt(cells[7] ?? '', 10) || 0,
    })
  }
  return rows
}

/** 统计结果。 */
export interface RecordSummary {
  /** 已考场次。 */
  sessions: number
  /** 均分（一位小数）；没记录时为 0。 */
  average: number
  /** 练过的题号（升序）。 */
  practiced: number[]
  /** 每个失分项出现的次数。 */
  lostCounts: Record<string, number>
  /** 出现 ≥3 次的失分项（才配叫「老毛病」）。 */
  oldHabits: string[]
}

/** 现算统计：场次、均分、已练题号、失分项计数、老毛病。 */
export function summarize(rows: readonly RecordRow[]): RecordSummary {
  const practiced = [...new Set(rows.map((row) => row.caseNo))].sort((a, b) => a - b)
  const total = rows.reduce((sum, row) => sum + row.score, 0)
  const lostCounts: Record<string, number> = {}
  for (const row of rows) {
    for (const item of row.lost.split(/[、，,;；]/)) {
      const key = item.trim()
      if (key === '') continue
      lostCounts[key] = (lostCounts[key] ?? 0) + 1
    }
  }
  const oldHabits = Object.entries(lostCounts)
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([item]) => item)
  return {
    sessions: rows.length,
    average: rows.length === 0 ? 0 : Math.round((total / rows.length) * 10) / 10,
    practiced,
    lostCounts,
    oldHabits,
  }
}

/** 读记录：返回第一条可读文件的战绩与路径。 */
export async function readRecords(fallbackDir?: string): Promise<{ rows: RecordRow[]; path?: string; summary: RecordSummary }> {
  for (const path of recordsPathCandidates(fallbackDir)) {
    try {
      const text = await readFile(path, 'utf8')
      const rows = parseRecords(text)
      return { rows, path, summary: summarize(rows) }
    } catch {
      // 读不到就当这份不存在，继续看下一个候选。
    }
  }
  return { rows: [], summary: summarize([]) }
}

/** 写入结果。 */
export interface AppendResult {
  ok: boolean
  /** 实际写入的路径。 */
  path?: string
  /** 失败原因（静默降级时只进工具返回，不抛错）。 */
  reason?: string
}

/** 追加一行战绩：哪个候选能写就写哪个，全都不行则静默降级。 */
export async function appendRecord(row: RecordRow, fallbackDir?: string): Promise<AppendResult> {
  const line = `| ${row.at} | ${String(row.caseNo).padStart(2, '0')} | ${row.disease} | ${row.score} | ${row.verdict} | ${row.lost} | ${row.minutes} min | ${row.help} |\n`
  const reasons: string[] = []
  for (const path of recordsPathCandidates(fallbackDir)) {
    try {
      await mkdir(dirname(path), { recursive: true })
      let needsHeader = true
      try {
        const info = await stat(path)
        needsHeader = info.size === 0
      } catch {
        needsHeader = true
      }
      await appendFile(path, needsHeader ? HEADER + line : line, 'utf8')
      return { ok: true, path }
    } catch (error) {
      reasons.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { ok: false, reason: reasons.join(' | ') }
}
