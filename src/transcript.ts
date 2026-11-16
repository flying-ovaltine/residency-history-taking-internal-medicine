/**
 * 会话历史回溯：把本轮考试里的「考生问了什么、病人答了什么」从当前会话日志里取出来。
 *
 * 用的是 DSH 官方 `ctx.sessions` 服务（`Session.snapshotEvents` + 事件类型
 * `user/message` / `assistant/message`），**不是**编造的接口。
 * 取不到（服务缺失、会话不在内存、事件结构变化）就返回 undefined，
 * 由 `osce_finish` 退回到模型自己还原的问句清单 —— 两条路都支持，优先取历史。
 *
 * 注意：会话日志里除了考生的问诊句，还有运行时注入的上下文（system-reminder、
 * runtime context、hindsight 页面、技能清单……）。这些**不是**问诊，必须滤掉，
 * 否则评分实录会被注入文本灌满。见 `isNoise` 与 `MAX_QUESTION_LENGTH`。
 */

/** 一条对话。 */
export interface TranscriptTurn {
  /** candidate = 考生（使用者），patient = 病人（模型扮演）。 */
  role: 'candidate' | 'patient'
  /** 该轮的话，较长时截断。 */
  text: string
}

/** 回溯结果。 */
export interface Transcript {
  turns: TranscriptTurn[]
  /** 日志里参与本轮的消息总数（过滤前）。 */
  total: number
  /** 被当成非问诊消息滤掉的条数。 */
  skipped: number
  /** 是否因过长而截断。 */
  truncated: boolean
}

/** 运行时注入内容的特征串：命中即不算问诊。 */
const NOISE_MARKERS = [
  'system-reminder',
  'Current runtime context',
  'current working directory',
  'Current DSH file policy',
  'Current DeepSeek Harness',
  '<hindsight_pages>',
  '<available_skills>',
  'available-skills',
  'This is an automated',
  'tool_call',
]

/** 超过这个长度的 user 消息基本不是一句问诊（多为粘贴或注入）。 */
const MAX_QUESTION_LENGTH = 2000

/** 把消息里的 content 拉平成纯文本（只取 text 块）。 */
function contentToText(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const item = block as { type?: unknown; text?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join('\n').trim()
}

/** 过滤掉运行时注入与非问诊内容。 */
function isNoise(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  if (trimmed.startsWith('<')) return true
  if (trimmed.length > MAX_QUESTION_LENGTH) return true
  return NOISE_MARKERS.some((marker) => trimmed.includes(marker))
}

/**
 * 从会话日志中截取 fromSeq 之后的对白。
 *
 * @param session   会话对象（`ctx.sessions.get(id)`），缺方法即视为不可用。
 * @param fromSeq   开考时的日志偏移（`session.seq`）。
 */
export function extractTranscript(session: unknown, fromSeq: number): Transcript | undefined {
  if (session === null || typeof session !== 'object') return undefined
  const target = session as {
    snapshotEvents?: (from: number) => unknown
    seq?: number
  }
  if (typeof target.snapshotEvents !== 'function') return undefined

  let events: unknown
  try {
    events = target.snapshotEvents(fromSeq)
  } catch {
    return undefined
  }
  if (!Array.isArray(events)) return undefined

  const turns: TranscriptTurn[] = []
  let total = 0
  let skipped = 0
  let truncated = false
  const MAX_TURNS = 240
  const MAX_CANDIDATE = 400
  const MAX_PATIENT = 160

  for (const raw of events) {
    if (raw === null || typeof raw !== 'object') continue
    const event = raw as { type?: unknown; data?: unknown }
    const data = event.data
    if (data === null || typeof data !== 'object') continue

    let role: TranscriptTurn['role'] | undefined
    let message: unknown
    if (event.type === 'user/message') {
      role = 'candidate'
      message = data
    } else if (event.type === 'assistant/message') {
      role = 'patient'
      message = (data as { message?: unknown }).message
    } else {
      continue
    }

    const text = contentToText(message)
    if (isNoise(text)) {
      skipped += 1
      continue
    }
    total += 1
    if (turns.length >= MAX_TURNS) {
      truncated = true
      continue
    }
    const limit = role === 'candidate' ? MAX_CANDIDATE : MAX_PATIENT
    turns.push({
      role,
      text: text.length > limit ? `${text.slice(0, limit)}…` : text,
    })
  }

  return { turns, total, skipped, truncated }
}

/** 考生真正问出口的句子条数（评分的唯一依据）。 */
export function candidateCount(transcript: Transcript): number {
  return transcript.turns.filter((turn) => turn.role === 'candidate').length
}

/** 把回溯结果排成便于模型逐条还原的文本。 */
export function renderTranscript(transcript: Transcript): string {
  if (transcript.turns.length === 0) {
    return transcript.skipped > 0
      ? `（会话日志里的 ${transcript.skipped} 条消息全是运行时注入，没有捕捉到考生问句）`
      : '（没有取到任何对白）'
  }
  const lines = transcript.turns.map((turn, index) => {
    const label = turn.role === 'candidate' ? '考生' : '病人（模型输出）'
    return `${index + 1}. 【${label}】${turn.text.replace(/\n+/g, ' ')}`
  })
  if (transcript.skipped > 0) lines.push(`（已滤掉 ${transcript.skipped} 条运行时注入 / 超长文本）`)
  if (transcript.truncated) lines.push(`…（共 ${transcript.total} 条，已截断）`)
  return lines.join('\n')
}
