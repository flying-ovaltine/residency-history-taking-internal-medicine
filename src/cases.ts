/**
 * 病例库：目录扫描、元信息解析、抽题、按阶段裁剪。
 *
 * 病例正文一个字都不写进代码：全部在运行时从
 * `resources/skills/history-taking-exam/references/case-NN-*.md` 读原文。
 * 这里只解析标题与几个可机读的标注行（对应病种 / 难度 / 主线），
 * 以及按 `## 一、` 这类二级标题切片，做**阶段隔离**：
 *
 *   SP 阶段  → 一、角色卡 + 二、问诊分层 + 三、陷阱设计 + 四、既往史等
 *   考官阶段 → 全部（含 五、标准病历 + 六、考官提示）
 *
 * 这样「标准病历 / 诊断 / 鉴别要点」在 SP 阶段根本不会出现在返回里，
 * 不靠模型自觉，靠插件本身挡住。
 */

import { join } from 'node:path'

import { listCaseFileNames, readText, referencesDir } from './resources.js'

/** 病例元信息（不含正文）。 */
export interface CaseMeta {
  /** 题号：1–32。 */
  no: number
  /** 文件名，例如 case-01-iron-deficiency-anemia.md。 */
  file: string
  /** 病种全名，例如「缺铁性贫血」。 */
  name: string
  /** 标题括号里的专科，例如「血液内科」。 */
  department: string
  /** 短专科标签，用于开场「第 07 题（内分泌）」。 */
  departmentShort: string
  /** 「对应建议病种」里 破折号后的病种名，例如「贫血」。 */
  disease: string
  /** 难度星标，例如「★★☆」。 */
  difficulty: string
  /** 主线一句话。 */
  mainline: string
}

/** 病例元信息 + 正文。 */
export interface CaseFull extends CaseMeta {
  text: string
}

/** 抽题结果。 */
export interface PickedCase {
  meta: CaseMeta
  /** 抽题依据，写进开场便于自查：pointed / unpracticed / random / extra / fallback。 */
  reason: 'pointed' | 'unpracticed' | 'random' | 'extra' | 'fallback'
}

/** 考纲内随机池：case-01 至 case-29。 */
export const EXAM_POOL_MIN = 1
export const EXAM_POOL_MAX = 29

/** 清单外血液加练：case-30 至 case-32，默认不进随机池。 */
export const EXTRA_POOL_MIN = 30
export const EXTRA_POOL_MAX = 32

/** 专科同义词表：把用户口语（心内、肾内、血液）映射到标题里的专科词根。 */
const DEPARTMENT_ALIASES: Record<string, string> = {
  心内: '心血管',
  心血管: '心血管',
  循环: '心血管',
  呼吸: '呼吸',
  消化: '消化',
  内分泌: '内分泌',
  代谢: '内分泌',
  肾内: '肾脏',
  肾脏: '肾脏',
  肾: '肾脏',
  风湿: '风湿',
  免疫: '风湿',
  血液: '血液',
  感染: '感染',
  传染: '感染',
  神经: '神经',
}

/** 把专科字符串归一成词根集合，例如「风湿免疫科 / 内分泌代谢」→ [风湿, 内分泌]。 */
function departmentRoots(department: string): string[] {
  const roots: string[] = []
  for (const part of department.split(/[／/、，,·]/)) {
    const token = part.trim().replace(/内科$|科$|代谢$|病$|学$/g, '')
    if (token === '') continue
    roots.push(DEPARTMENT_ALIASES[token] ?? token)
  }
  return roots
}

/** 专科是否匹配用户点名（宽松：任一词根互相包含即算命中）。 */
export function matchesDepartment(department: string, query: string): boolean {
  const wanted = departmentRoots(query)
  if (wanted.length === 0) return false
  const owned = departmentRoots(department)
  return wanted.some((word) => owned.some((root) => root.includes(word) || word.includes(root)))
}

/** 病种是否匹配用户点名（宽松：标题、病种、主线任一处包含即算命中）。 */
export function matchesDisease(meta: CaseMeta, query: string): boolean {
  const needle = query.trim()
  if (needle === '') return false
  const haystack = `${meta.name} ${meta.disease} ${meta.mainline}`
  return haystack.includes(needle) || needle.includes(meta.disease)
}

/** 从标题行解析病种与专科。 */
function parseTitle(text: string): { name: string; department: string } {
  const match = /^#\s*病例\s*\d+\s*[·・]\s*(.+?)\s*$/m.exec(text)
  const raw = match?.[1]?.trim() ?? ''
  if (raw === '') return { name: '', department: '' }
  // 贪婪匹配到**最后一个**括号，避免把「（IgA 肾病，肾脏内科）」里的病种切进专科。
  const split = /^(.+)（([^（）]*)）$/.exec(raw)
  if (split === null) return { name: raw, department: '' }
  const subject = (split[1] ?? raw).trim()
  const outer = (split[2] ?? '').trim()
  // 括号里可能写成「病种，专科」（如「化脓性脑膜炎，感染科」），后半段才是专科。
  const parts = outer
    .split(/[，,]/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  const isDepartment = (value: string): boolean => /(内科|外科|科|医学|代谢)$/.test(value)
  const lastPart = parts[parts.length - 1]
  if (parts.length > 1 && lastPart !== undefined && isDepartment(lastPart)) {
    const inner = parts.slice(0, -1).join('，')
    return { name: `${subject}（${inner}）`, department: lastPart }
  }
  return { name: subject, department: outer }
}

/** 在正文里取一行标注字段，例如 **难度**：★★☆。 */
function parseField(text: string, label: string): string {
  const pattern = new RegExp(`\\*\\*${label}\\*\\*\\s*[：:]\\s*(.+)`)
  return pattern.exec(text)?.[1]?.trim() ?? ''
}

/** 从单个病例文件的正文解析元信息。 */
export function parseCaseMeta(file: string, text: string): CaseMeta | undefined {
  const noMatch = /^case-(\d{2})-/i.exec(file)
  if (noMatch === null) return undefined
  const no = Number(noMatch[1])
  if (!Number.isFinite(no) || no <= 0) return undefined

  const title = parseTitle(text)
  const diseaseRaw = parseField(text, '对应建议病种')
  const disease = diseaseRaw.includes('—') ? (diseaseRaw.split('—').pop() ?? diseaseRaw).trim() : diseaseRaw
  const department = title.department
  const firstPart = department.split(/[／/]/)[0]?.trim() ?? ''
  const departmentShort = firstPart.replace(/内科$|科$/g, '').trim()

  return {
    no,
    file,
    name: title.name === '' ? file.replace(/^case-\d{2}-|\.md$/g, '') : title.name,
    department,
    departmentShort: departmentShort === '' ? '内科' : departmentShort,
    disease: disease === '' ? title.name : disease,
    difficulty: parseField(text, '难度'),
    mainline: parseField(text, '主线'),
  }
}

let catalogCache: CaseMeta[] | undefined

/** 列出全部病例元信息（按题号升序）。首次调用后进程内缓存。 */
export async function loadCatalog(): Promise<CaseMeta[]> {
  if (catalogCache !== undefined) return catalogCache
  const files = await listCaseFileNames()
  const metas: CaseMeta[] = []
  for (const file of files) {
    const text = await readText(join(referencesDir, file))
    if (text === undefined) continue
    const meta = parseCaseMeta(file, text)
    if (meta !== undefined) metas.push(meta)
  }
  metas.sort((a, b) => a.no - b.no)
  catalogCache = metas
  return metas
}

/** 取单个病例的元信息。 */
export async function findCase(no: number): Promise<CaseMeta | undefined> {
  return (await loadCatalog()).find((meta) => meta.no === no)
}

/** 读一个病例的完整原文。 */
export async function readCase(no: number): Promise<CaseFull | undefined> {
  const meta = await findCase(no)
  if (meta === undefined) return undefined
  const text = await readText(join(referencesDir, meta.file))
  if (text === undefined) return undefined
  return { ...meta, text }
}

/** 候选题号池：加练走 30–32，否则 1–29。 */
export function candidatePool(extra: boolean): number[] {
  const min = extra ? EXTRA_POOL_MIN : EXAM_POOL_MIN
  const max = extra ? EXTRA_POOL_MAX : EXAM_POOL_MAX
  const numbers: number[] = []
  for (let no = min; no <= max; no += 1) numbers.push(no)
  return numbers
}

/** 从候选里挑一个：优先没练过；都没练过就随机；全练过也随机。 */
function pickFromPool(pool: CaseMeta[], practiced: ReadonlySet<number>): { meta: CaseMeta; reason: PickedCase['reason'] } | undefined {
  if (pool.length === 0) return undefined
  const fresh = pool.filter((meta) => !practiced.has(meta.no))
  const source = fresh.length > 0 ? fresh : pool
  const index = Math.floor(Math.random() * source.length)
  const meta = source[index]
  if (meta === undefined) return undefined
  return { meta, reason: fresh.length > 0 ? 'unpracticed' : 'random' }
}

/** 抽题：点名题号 > 点名专科/病种 > 清单外加练 > 考纲内随机。 */
export async function pickCase(options: {
  caseNo?: number
  department?: string
  disease?: string
  extra?: boolean
  practiced?: ReadonlySet<number>
}): Promise<PickedCase | undefined> {
  const catalog = await loadCatalog()
  if (catalog.length === 0) return undefined
  const practiced = options.practiced ?? new Set<number>()

  // 1) 直接把题号报出来（含 30–32，此时按加练处理并注明）。
  if (options.caseNo !== undefined && Number.isFinite(options.caseNo)) {
    const meta = catalog.find((item) => item.no === options.caseNo)
    if (meta !== undefined) {
      const isExtra = meta.no > EXAM_POOL_MAX
      return { meta, reason: isExtra ? 'extra' : 'pointed' }
    }
  }

  // 2) 点名专科或病种：在该子集内优先没练过。
  const wantsTopic = (options.department ?? '') !== '' || (options.disease ?? '') !== ''
  if (wantsTopic) {
    const extra = options.extra === true ? true : undefined
    const subset = catalog.filter((meta) => {
      if (extra !== undefined && (meta.no > EXAM_POOL_MAX) !== extra) return false
      const byDepartment = options.department !== undefined && options.department !== ''
        ? matchesDepartment(meta.department, options.department)
        : false
      const byDisease = options.disease !== undefined && options.disease !== ''
        ? matchesDisease(meta, options.disease)
        : false
      // 专科与病种同时点名时取并集，避免用户说「血液的白血病」被卡死。
      return byDepartment || byDisease
    })
    const pool = extra === undefined
      ? subset.filter((meta) => meta.no <= EXAM_POOL_MAX || options.extra === true)
      : subset
    const picked = pickFromPool(pool, practiced)
    if (picked !== undefined) return picked
    // 点名的专科/病种在库里没有：退回考纲内随机，由模型在开场说明。
    const fallback = pickFromPool(catalog.filter((meta) => meta.no <= EXAM_POOL_MAX), practiced)
    return fallback === undefined ? undefined : { ...fallback, reason: 'fallback' }
  }

  // 3) 明确要求清单外加练。
  if (options.extra === true) {
    const picked = pickFromPool(catalog.filter((meta) => meta.no > EXAM_POOL_MAX), practiced)
    if (picked !== undefined) return { meta: picked.meta, reason: 'extra' }
  }

  // 4) 默认随机：只在考纲内 01–29。
  const picked = pickFromPool(catalog.filter((meta) => meta.no <= EXAM_POOL_MAX), practiced)
  return picked
}

/** 一个二级标题切片。 */
interface Section {
  title: string
  body: string
}

/** 按 `## ` 二级标题切片；首个标题之前的内容作为 title 为空的片段保留。 */
function splitSections(text: string): Section[] {
  const lines = text.split(/\r?\n/)
  const sections: Section[] = []
  let title = ''
  let buffer: string[] = []
  const flush = (): void => {
    if (buffer.length === 0 && title === '') return
    sections.push({ title, body: buffer.join('\n').trim() })
  }
  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush()
      title = line.slice(3).trim()
      buffer = [line]
      continue
    }
    buffer.push(line)
  }
  flush()
  return sections
}

/** 考后内容（只在考官阶段返回）的标题特征。 */
const POST_EXAM_MARKERS = ['标准病历', '考官提示']

function isPostExamSection(title: string): boolean {
  return POST_EXAM_MARKERS.some((marker) => title.includes(marker))
}

/** SP 阶段可见内容：剥掉「标准病历」「考官提示」两节。 */
export function spView(full: CaseFull): string {
  const sections = splitSections(full.text)
  const kept = sections.filter((section) => !isPostExamSection(section.title))
  const head = `<!-- 阶段隔离：SP 扮演中，仅返回角色卡 / 问诊分层 / 陷阱设计 / 既往史等前置内容。
     标准病历与考官提示将在「结束考试」后由 osce_finish 返回。 -->\n`
  return head + kept.map((section) => section.body).filter((body) => body !== '').join('\n\n')
}

/** 标准病历一节（供考官阶段对照）。 */
export function standardRecord(full: CaseFull): string {
  const sections = splitSections(full.text)
  return sections
    .filter((section) => section.title.includes('标准病历'))
    .map((section) => section.body)
    .join('\n\n')
}

/** 考官提示一节（判分要点）。 */
export function examinerNotes(full: CaseFull): string {
  const sections = splitSections(full.text)
  return sections
    .filter((section) => section.title.includes('考官提示'))
    .map((section) => section.body)
    .join('\n\n')
}

/** 考官阶段完整原文。 */
export function gradingView(full: CaseFull): string {
  return full.text
}

/** 只取「SP 角色卡」一节（模式 C 出题时给角色设定，不给问诊分层与陷阱）。 */
export function roleCard(full: CaseFull): string {
  const sections = splitSections(full.text)
  const kept = sections.filter((section) => section.title.includes('SP 角色卡'))
  if (kept.length === 0) return `（${full.name}：角色卡缺失）`
  return kept.map((section) => section.body).join('\n\n')
}

/** 取「陷阱设计」一节（模式 B 单点训练时可选给）。 */
export function trapSection(full: CaseFull): string {
  const sections = splitSections(full.text)
  return sections
    .filter((section) => section.title.includes('陷阱设计'))
    .map((section) => section.body)
    .join('\n\n')
}

/** 从角色卡「开场状态」里取一句动作描写，用于开场最后一行。 */
export function openingAction(full: CaseFull): string {
  const match = /\*\*开场状态\*\*[：:]\s*(.+)/.exec(full.text)
  const state = match?.[1]?.trim() ?? ''
  if (state === '') return '（患者坐在诊室里，抬眼看你，没有先开口）'
  const cleaned = state.replace(/[。.]$/, '')
  return `（患者${cleaned.startsWith('坐') ? '' : '在诊室里，'}${cleaned}）`
}
