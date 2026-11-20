/**
 * dsh-osce-history-internal-medicine
 * 住培 / 规培结业考「病人接诊站 · 病史采集」陪练（内科）—— DeepSeek Harness 插件
 *
 * 本文件是 v1.4.0 的 DSH 适配版：实现与素材来自上游 v1.4.0，只做了三处必要改动
 * （见文件末尾「DSH 适配说明」）。
 *
 * 设计原则（改代码前先读这三条）：
 * 1. 中文素材（病例脚本、评分表、手册、人设）全部原样放在 resources/ 里，运行时读文件，
 *    不硬编码进本文件。改内容只改 Markdown，不用碰代码。
 * 2. 只依赖宿主真的能解析的东西：本 profile 里没有 @deepseek-ai/*，所以不用 defineTool /
 *    schemastery，直接传同结构的纯对象给 ctx.tools.register，inject 声明 'tools'。
 * 3. 分数由模型按评分表判，本插件只负责「给材料 + 记状态 + 落记录」。
 *    插件不做判分，是因为判分要引用考生的原话，而原话在会话里、不在工具里。
 */
import { promises as fs } from 'node:fs'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-osce-history-internal-medicine'
export const inject = ['tools']

/** defineTool 的本地等价物：宿主只要求 ToolDefinition 结构（name/description/parameters/output/execute）。 */
const defineTool = (definition) => definition

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RES = path.join(HERE, 'resources')
const SKILL = path.join(RES, 'skills', 'history-taking-exam')
const REF = path.join(SKILL, 'references')
const AGENT_MD = path.join(RES, 'agents', 'residency-history-taking-internal-medicine.md')

/** 可用 osce_rules 取的手册；abs 有值就直接用绝对路径，否则拼到 references/ 下 */
const RULE_FILES = {
  persona: { abs: AGENT_MD, label: '考官「问渠」人设与判分铁律' },
  sp: { file: 'SP扮演手册.md', label: 'SP 扮演手册（十条禁令 + 主动提问池）' },
  combat: { file: '实战模式.md', label: '实战模式（隐瞒训练叠加层）' },
  examiner: { file: '考官评分手册.md', label: '考官评分手册（切换、还原、判分）' },
  rubric: { file: '评分表.md', label: '官方 100 分评分表（18 行）' },
  quick: { file: '速查卡.md', label: '32 例速查卡（每例 5 句核心问句）' },
  skill: { file: '../SKILL.md', label: '技能主文件（流程、口令、四模式）' },
}

/** 单实例状态：同一进程同时只跑一场考试（多会话并发会互相覆盖，README 已注明） */
const state = { phase: 'idle', no: null, mode: 'normal', startedAt: null, lastCase: null }

const pad2 = (n) => String(n).padStart(2, '0')

function expandHome(p) {
  if (!p) return p
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

function nowStamp() {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (e) {
    throw new Error(`读不到素材文件：${file}（${e.code || e.message}）。请确认插件目录完整，resources/ 没有被裁剪。`)
  }
}

/* ------------------------------------------------------------------ *
 * 病例索引：从每例第一行的标题解析，不另建一份元数据，避免两边不同步
 * 例：# 病例 04 · 社区获得性肺炎（呼吸内科）
 * ------------------------------------------------------------------ */
async function listCases() {
  let files
  try {
    files = await fs.readdir(REF)
  } catch (e) {
    throw new Error(`读不到病例目录：${REF}（${e.code || e.message}）`)
  }
  const out = []
  for (const f of files) {
    if (!/^case-\d+.*\.md$/.test(f)) continue
    const head = (await fs.readFile(path.join(REF, f), 'utf8')).split('\n').slice(0, 3).join('\n')
    const m = head.match(/#\s*病例\s*(\d+)\s*·\s*(.+)/)
    if (!m) continue
    const no = Number(m[1])
    let title = m[2].trim()
    let dept = ''
    const dm = title.match(/^(.*?)（(.+)）\s*$/)
    if (dm) {
      title = dm[1].trim()
      dept = dm[2].trim()
    }
    out.push({ no, file: f, name: title, dept })
  }
  out.sort((a, b) => a.no - b.no)
  return out
}

function findCase(cases, no) {
  const n = Number(String(no).replace(/\D/g, ''))
  return cases.find((c) => c.no === n) || null
}

/** 把一例拆成「SP 可用」和「考后」两段：割在「五、标准病历」之前 */
function splitCase(text) {
  const idx = text.search(/\n##\s*五、\s*标准病历/)
  if (idx < 0) return { sp: text.trim(), grading: text.trim() }
  return { sp: text.slice(0, idx).trim(), grading: text.slice(idx).trim() }
}

/* ------------------------------------------------------------------ *
 * 训练记录
 * 列：日期时间｜题号｜病种｜总分｜判定｜主要失分项｜用时｜求助｜模式
 * 「模式」固定放最后一列：旧 8 列行缺末格即按普通模式算，不改写、不重排旧行
 * ------------------------------------------------------------------ */
async function readRecords(file) {
  const p = expandHome(file)
  let raw = ''
  try {
    raw = await fs.readFile(p, 'utf8')
  } catch {
    return { path: p, rows: [], exists: false }
  }
  const rows = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((s) => s.trim())
    if (cells.length < 8) continue
    if (cells[0] === '日期时间') continue
    if (!/^\d{4}-\d{2}-\d{2}/.test(cells[0])) continue
    const score = Number(cells[3])
    rows.push({
      at: cells[0],
      no: cells[1],
      name: cells[2],
      score: Number.isFinite(score) ? score : null,
      verdict: cells[4],
      weak: cells[5] === '-' ? '' : cells[5],
      duration: cells[6] || '',
      help: cells[7] || '0',
      mode: cells.length >= 9 && cells[8] ? cells[8] : '普通',
    })
  }
  return { path: p, rows, exists: true }
}

/** 统计：mode 传「普通」/「实战」只算该模式；不传算全部 */
function summarize(rows, mode) {
  const scoped = mode ? rows.filter((r) => r.mode === mode) : rows
  const scored = scoped.filter((r) => typeof r.score === 'number')
  const total = scoped.length
  const avg = scored.length ? scored.reduce((s, r) => s + r.score, 0) / scored.length : 0
  const practiced = new Set(scoped.map((r) => String(r.no).replace(/\D/g, '').padStart(2, '0')))
  const weakCount = new Map()
  for (const r of scoped) {
    if (!r.weak) continue
    for (const w of r.weak.split(/[、,，;；/]/).map((s) => s.trim()).filter(Boolean)) {
      weakCount.set(w, (weakCount.get(w) || 0) + 1)
    }
  }
  const chronic = [...weakCount.entries()].filter(([, n]) => n >= 3).map(([w, n]) => `${w}（${n} 次）`)
  return { total, avg, practiced, chronic, rows: scoped }
}

async function appendRecord(file, row) {
  const p = expandHome(file)
  const header =
    '# 病史采集训练记录\n\n' +
    '| 日期时间 | 题号 | 病种 | 总分 | 判定 | 主要失分项 | 用时 | 求助 | 模式 |\n' +
    '|---|---|---|---|---|---|---|---|---|\n'
  let existing = ''
  try {
    existing = await fs.readFile(p, 'utf8')
  } catch {
    existing = ''
  }
  if (!existing.trim()) {
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, header + row + '\n', 'utf8')
    return { ok: true, path: p, created: true }
  }
  // 老记录是 8 列表头：补「模式」列，但已写入的行原样不动（缺末格 = 普通模式）
  let text = existing
  const lines = text.split('\n')
  const hi = lines.findIndex((l) => l.includes('日期时间') && l.trim().startsWith('|'))
  if (hi >= 0 && !lines[hi].includes('模式')) {
    lines[hi] = '| 日期时间 | 题号 | 病种 | 总分 | 判定 | 主要失分项 | 用时 | 求助 | 模式 |'
    if (lines[hi + 1] && /^\|[\s\-|:]+\|$/.test(lines[hi + 1].trim())) {
      lines[hi + 1] = '|---|---|---|---|---|---|---|---|---|'
    }
    text = lines.join('\n')
  }
  if (!text.endsWith('\n')) text += '\n'
  try {
    await fs.writeFile(p, text + row + '\n', 'utf8')
    return { ok: true, path: p, created: false }
  } catch (e) {
    return { ok: false, path: p, error: e.code || e.message }
  }
}

/* ------------------------------------------------------------------ *
 * 抽题
 * ------------------------------------------------------------------ */
const ALIAS = {
  心内: ['心血管'],
  心内科: ['心血管'],
  心血管: ['心血管'],
  呼吸: ['呼吸'],
  呼吸科: ['呼吸'],
  消化: ['消化'],
  血液: ['血液'],
  血液科: ['血液'],
  内分泌: ['内分泌'],
  肾内: ['肾脏'],
  肾脏: ['肾脏'],
  风湿: ['风湿'],
  感染: ['感染'],
}

function matchDiscipline(c, q) {
  const keys = ALIAS[q] || [q]
  const hay = `${c.name} ${c.dept}`
  return keys.some((k) => k && hay.includes(k))
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

/* ------------------------------------------------------------------ *
 * 开场与铁律
 * ------------------------------------------------------------------ */
const PERSONA_LINE = `【你是谁】考官「问渠」：严格但不刁难；当考官时话少但有分量，当病人时像真人说话、绝不蹦单词。完整人设调 osce_rules("persona")。`

const IRON_RULES = `【本轮铁律（细节调 osce_rules 取手册）】
1 不主动：不报主诉、不补没被问到的信息、不提示遗漏
2 不说术语：不用诊断名和医学名词，用病人的话
3 一次一个点，但必须是完整的句子——绝不蹦单词，禁止出现「浓的。」「三天。」「开始的，」这类
4 不出戏：不出现「考官」「评分」「这题考的是」
5 不改题：脚本没有的一律不加；脚本写「无」的不许演成「有」；数值只能口语化，不许另起一个数
6 不用身体暗示（停顿、变脸、叹气）代替脚本指定的「含混带过」
7 括号里的内容是表演说明，不是台词，绝对不能念出来
8 SP 主动提问：先抛该例「陷阱设计」写明的，再按手册六类池补一条生活问题（吃喝、能不能干活、要不要住院）`

const COMBAT_RULES = `【实战四条（叠加层，优先级低于该例「陷阱设计」）】
① 开场只给一句问候（「你好。」「医生你好。」），不给题号、不给专科、不给主诉
② 病史只给最近这一次，追问才一层层往回剥（咳嗽5年加重1天 → 先只说「咳嗽，昨天开始的」）
③ 慢性病 / 用药 / 家族 / 传染病四类：第一次问一律轻描淡写或否认，追到具体才认；脚本写「无」的始终「没有」，不许把「没有」演成「好像有点高」
④ 检查单不主动展示：问「带了没」才承认、追「能给我看看吗」才拿出来；内容只能取该例「标准病历 · 辅助检查」，那里没有的就说「没查」，绝不现编
另：不设时限，不催不提示；病人是「急」不是「冷脸」（怕花钱、想快点看完、还得回去上班）`

function buildOpening(c, mode, stat) {
  const lines = []
  if (mode === 'combat') {
    lines.push('【实战模式 · 病史采集】')
    if (stat.total > 0) lines.push(`第 ${stat.total + 1} 场｜均分 ${stat.avg.toFixed(1)}`)
    lines.push('不限时，问完了说「结束考试」')
    lines.push('—————————————')
    lines.push('（开场由你以病人身份说一句问候，别加任何题目信息）')
  } else {
    lines.push('【考站：病人接诊 · 病史采集】')
    lines.push(`抽到：第 ${pad2(c.no)} 题（${c.dept}）`)
    if (stat.total > 0) lines.push(`第 ${stat.total + 1} 场｜均分 ${stat.avg.toFixed(1)}`)
    lines.push('时间：约 20 分钟，说完说「结束考试」')
    lines.push('—————————————')
    lines.push('（病人坐在诊室里，抬眼看你，没有先开口）')
  }
  return lines.join('\n')
}

const out = () => ({
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
})

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */
export function apply(ctx, config) {
  // 记录默认沿用规格里的路径（用户已有历史就在这儿），可用 patch 的 config.recordsFile 覆盖
  const cfg = { recordsFile: '~/.workbuddy/history-taking-records.md', passLine: 80, ...(config || {}) }

  const tool = (def) => ctx.tools.register(defineTool(def))

  /* 0. 把 SKILL.md 也注册成 DSH 技能：技能清单里搜得到，/history-taking-exam 也能直接调。
        宿主没有 skills 服务时静默跳过——五个工具不依赖它。 */
  try {
    const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
    if (skills !== undefined && skills !== null && typeof skills.register === 'function') {
      const raw = readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8').replace(/^\uFEFF/, '')
      const head = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(raw)
      const fm = head ? head[1] : ''
      const field = (key) => {
        const hit = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm)
        return hit ? (hit[1] || '').trim().replace(/^["']|["']$/g, '') : ''
      }
      const description = field('description')
      const content = head ? raw.slice(head[0].length).trimStart() : raw
      if (description !== '' && content !== '') {
        skills.register({
          name: field('name') || 'history-taking-exam',
          description,
          content,
          resourceBase: { kind: 'directory', path: SKILL },
          source: 'runtime',
        })
      }
    }
  } catch {
    // 技能注册是加分项，失败不影响工具
  }

  /* 1. 开考 ---------------------------------------------------------- */
  tool({
    name: 'osce_start',
    description:
      '开一场内科病史采集考试：抽题、读取该例脚本、记开始时间，返回开场抬头（普通模式）或开场约束（实战模式）+ SP 脚本正文（不含标准病历）。' +
      '用户说「开始考试」时调用。**若用户没说难度，先问一句「普通模式还是实战模式？」，拿到答案再调用本工具**——没抽题就问模式，是因为实战模式的开场本身不能出现题号。',
    parameters: {
      mode: {
        type: 'string',
        description: "难度。'normal' = 普通模式（默认）；'combat' = 实战模式（病人隐瞒病史、既往史、检查单，追问才给）。",
      },
      discipline: {
        type: 'string',
        description: '可选。专科或病种关键词，如「呼吸」「心内」「血液」「内分泌」「胰腺炎」。不填则全科随机。',
      },
      extra: {
        type: 'boolean',
        description: '可选。true 才允许抽清单外加练题（case-30~32：再障 / 骨髓瘤 / 淋巴瘤）。默认 false。',
      },
    },
    output: out(),
    async execute(args = {}) {
      const mode = args.mode === 'combat' ? 'combat' : 'normal'
      const cases = await listCases()
      if (!cases.length) return '病例目录是空的，插件资源没装全。'

      let pool = cases
      if (!args.extra) pool = cases.filter((c) => c.no <= 29)
      if (args.discipline) {
        const hit = pool.filter((c) => matchDiscipline(c, String(args.discipline).trim()))
        if (hit.length) pool = hit
      }
      if (!pool.length) pool = cases.filter((c) => c.no <= 29)

      const rec = await readRecords(cfg.recordsFile)
      const stat = summarize(rec.rows, mode === 'combat' ? '实战' : '普通')
      const fresh = pool.filter((c) => !stat.practiced.has(pad2(c.no)))
      const chosen = pickRandom(fresh.length ? fresh : pool)

      const text = await readText(path.join(REF, chosen.file))
      const { sp } = splitCase(text)

      state.phase = 'sp'
      state.no = chosen.no
      state.mode = mode
      state.startedAt = Date.now()

      const blocks = [
        buildOpening(chosen, mode, stat),
        '',
        mode === 'combat' ? COMBAT_RULES : '',
        PERSONA_LINE,
        IRON_RULES,
        '',
        `【病例脚本 · 第 ${pad2(chosen.no)} 题｜${chosen.name}｜${chosen.dept}】`,
        '（以下是脚本，供你扮演使用，不要把这段念给考生；五、标准病历已隐藏，考后由 osce_finish 给出）',
        '',
        sp,
        '',
        '【现在】直接以病人身份开口（普通模式可带上面那句动作描写），不要问「准备好了吗」，不要解释规则。',
      ]
      return blocks.filter((b) => b !== '').join('\n')
    },
  })

  /* 2. 读病例 -------------------------------------------------------- */
  tool({
    name: 'osce_get_case',
    description:
      '读取指定病例。stage="sp" 只返回角色卡、问诊分层、陷阱设计、既往史；stage="grading" 额外返回标准病历与考官提示。**SP 阶段取考后内容会被拒绝**——这是防剧透的硬约束。',
    parameters: {
      no: { type: 'string', description: '题号，如「04」「4」「14」。' },
      stage: { type: 'string', description: "可选。'sp' 或 'grading'。不填则按当前阶段：考试中给 sp，未开考给全部（相当于只出题模式 C）。" },
    },
    output: out(),
    async execute(args = {}) {
      const cases = await listCases()
      const c = findCase(cases, args.no ?? state.no)
      if (!c) return `找不到这个题号：${args.no}。可用题号 01–32。`
      const text = await readText(path.join(REF, c.file))
      const { sp, grading } = splitCase(text)
      const stage = args.stage || (state.phase === 'sp' ? 'sp' : 'all')
      if (stage === 'sp') {
        return `【第 ${pad2(c.no)} 题｜${c.name}｜${c.dept}】\n\n${sp}`
      }
      if (state.phase === 'sp' && state.no === c.no) {
        return `第 ${pad2(c.no)} 题正在考，标准病历与考官提示属于考后内容，现在不能给。先把这场问完，或调 osce_finish 收卷。\n\n${sp}`
      }
      return `【第 ${pad2(c.no)} 题｜${c.name}｜${c.dept}】\n\n${sp}\n\n${grading}`
    },
  })

  /* 3. 取手册 -------------------------------------------------------- */
  tool({
    name: 'osce_rules',
    description: '取规则手册全文：persona（考官「问渠」人设与铁律）/ sp（SP扮演手册）/ combat（实战模式）/ examiner（考官评分手册）/ rubric（官方100分评分表）/ quick（32例速查卡）/ skill（技能主文件）。讲标准、判分前拿不准口径时调它。',
    parameters: {
      which: { type: 'string', description: "persona | sp | combat | examiner | rubric | quick | skill。不填返回索引。" },
    },
    output: out(),
    async execute(args = {}) {
      const key = String(args.which || '').trim().toLowerCase()
      const item = RULE_FILES[key]
      if (!item) {
        return [
          '可取的规则手册：',
          ...Object.entries(RULE_FILES).map(([k, v]) => `- ${k}：${v.label}`),
        ].join('\n')
      }
      const text = await readText(item.abs || path.join(REF, item.file))
      return `【${item.label}】\n\n${text}`
    },
  })

  /* 4. 收卷 ---------------------------------------------------------- */
  tool({
    name: 'osce_finish',
    description:
      '收卷：停演切考官、算用时、把成绩写进训练记录，返回该例标准病历 + 官方评分表全文 + 判定口径。' +
      '**调用顺序**：用户说「结束考试」→ 先调本工具拿到标准病历和评分表 → 再写评分报告。' +
      '分数由你按评分表 18 行判，工具只记录，不替你判分。',
    parameters: {
      score: { type: 'number', description: '本场总分（0–100），按 18 行逐项加总后的结果。' },
      weakItems: { type: 'string', description: '主要失分项，顿号分隔，如「痰的性状、阴性鉴别、共情」。' },
      durationMin: { type: 'number', description: '可选。本场问诊用时（分钟）。只作参考，不因长而扣分。' },
      helpCount: { type: 'number', description: '可选。本场求助/提示次数，默认 0。' },
    },
    output: out(),
    async execute(args = {}) {
      const cases = await listCases()
      const c = findCase(cases, state.no || args.no)
      if (!c) return '当前没有正在进行的考试。先调 osce_start 开一场。'

      const score = Number(args.score)
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        return 'score 必须是你按评分表逐项加总后的 0–100 数字。先算完再调，不要传空值。'
      }

      const pass = cfg.passLine
      const verdict = score >= pass ? '通过' : score >= pass - 10 ? '临界' : '不通过'
      const duration =
        Number.isFinite(Number(args.durationMin)) && Number(args.durationMin) > 0
          ? `${Math.round(Number(args.durationMin))} min`
          : state.startedAt
            ? `${Math.max(1, Math.round((Date.now() - state.startedAt) / 60000))} min`
            : '-'
      const help = Number.isFinite(Number(args.helpCount)) ? String(Math.round(Number(args.helpCount))) : '0'
      const weak = (args.weakItems || '').toString().trim() || '-'
      const modeLabel = state.mode === 'combat' ? '实战' : '普通'

      const row = `| ${nowStamp()} | ${pad2(c.no)} | ${c.name} | ${Number(score.toFixed(1))} | ${verdict} | ${weak} | ${duration} | ${help} | ${modeLabel} |`
      const written = await appendRecord(cfg.recordsFile, row)

      const rec = await readRecords(cfg.recordsFile)
      const statAll = summarize(rec.rows)
      const statMode = summarize(rec.rows, modeLabel)
      const text = await readText(path.join(REF, c.file))
      const { sp, grading } = splitCase(text)
      const rubric = await readText(path.join(REF, '评分表.md'))

      state.phase = 'idle'
      state.lastCase = { no: c.no, mode: modeLabel, score }
      state.no = null
      state.startedAt = null

      const recordLine = written.ok
        ? `已写入训练记录：${written.path}${written.created ? '（新建）' : ''}`
        : `⚠ 这轮没能存进记录（${written.path}：${written.error}）——报告照出，别声称「已记录」。`

      const blocks = [
        `【收卷 · 第 ${pad2(c.no)} 题｜${c.name}｜${c.dept}｜${modeLabel}模式】`,
        `得分 ${Number(score.toFixed(1))}｜判定 ${verdict}（合格线 ${pass}）｜用时 ${duration}｜求助 ${help} 次`,
        recordLine,
        `累计：${statAll.total} 场，均分 ${statAll.avg.toFixed(1)}；本模式 ${statMode.total} 场，均分 ${statMode.avg.toFixed(1)}`,
        statAll.chronic.length ? `老毛病（同一失分项 ≥3 次）：${statAll.chronic.join('、')}` : '',
        '',
        '【接下来按这个顺序写报告】',
        '1 分隔线 + 【切换：考官】（不再补任何病人台词）',
        '2 逐条还原考生问过什么：问到 ✓ / 漏问 ✗ / 病人主动说的标「主动」（不计分）',
        '3 按下方评分表 18 行打分：标准分 / 得分 / 判据（引考生原话）',
        '4 扣分点：丢几分、丢在哪一行、当时该怎么问（给可照抄的问句）',
        '5 改进意见：落到能照做的一句话，不写「多练习」',
        '6 给标准病历供对照',
        '提醒：本插件只覆盖病史采集这半站（与体格检查各 100 分取平均，任一项 <80 整站不合格）。',
        '',
        '【官方 100 分评分表】',
        rubric,
        '',
        '【该例标准病历（考后对照）】',
        grading,
      ]
      return blocks.filter((b) => b !== '').join('\n')
    },
  })

  /* 5. 记录统计 ------------------------------------------------------ */
  tool({
    name: 'osce_stats',
    description: '读训练记录，返回场次、总均分、各模式均分、已练题号、老毛病（同一失分项出现 3 次以上）。开场想报「第几场」或用户问练得怎么样时调它。',
    parameters: {},
    output: out(),
    async execute() {
      const rec = await readRecords(cfg.recordsFile)
      if (!rec.rows.length) {
        return `还没有训练记录（${rec.path}${rec.exists ? '' : '，文件不存在'}）。这是第一场。`
      }
      const all = summarize(rec.rows)
      const normal = summarize(rec.rows, '普通')
      const combat = summarize(rec.rows, '实战')
      const lines = [
        `记录文件：${rec.path}`,
        `总场次 ${all.total}｜总均分 ${all.avg.toFixed(1)}`,
        `普通模式 ${normal.total} 场｜均分 ${normal.total ? normal.avg.toFixed(1) : '-'}`,
        `实战模式 ${combat.total} 场｜均分 ${combat.total ? combat.avg.toFixed(1) : '-'}`,
        `已练题号：${[...all.practiced].sort().join('、') || '无'}`,
        `未练题号（01–29）：${Array.from({ length: 29 }, (_, i) => pad2(i + 1)).filter((n) => !all.practiced.has(n)).join('、') || '全部练过'}`,
        all.chronic.length ? `老毛病（同一失分项 ≥3 次）：${all.chronic.join('、')}` : '老毛病：暂无（同一失分项需出现 3 次以上才点名）',
      ]
      const recent = all.rows.slice(-5)
      if (recent.length) {
        lines.push('', '最近 5 场：')
        for (const r of recent) lines.push(`- ${r.at}｜第 ${r.no} 题｜${r.name}｜${r.score}｜${r.verdict}｜${r.mode}`)
      }
      return lines.join('\n')
    },
  })
}


/* ------------------------------------------------------------------ *
 * DSH 适配说明（相对上游 v1.4.0 的全部改动，三处，不改任何业务逻辑）
 *
 * 1. 去掉 import z from '@deepseek-ai/schemastery' 与 export const Config：
 *    本机 profile 装的是应用内打包的宿主，profile 的 node_modules 里没有 @deepseek-ai/*，
 *    运行时 import 会 ERR_MODULE_NOT_FOUND（实测：装了直接 activate 失败）。
 *    配置项改为 apply 内部默认值 + patch 的 config 覆盖（整行替换语义不变）。
 * 2. import { defineTool } from '@deepseek-ai/dsh-tools' 换成等价的本地恒等函数：
 *    宿主只校验 ToolDefinition 结构，defineTool 本身不含运行时魔法。
 * 3. 记录默认路径从 ~/.dsh-osc/... 改为 ~/.workbuddy/history-taking-records.md，
 *    与规格一致，且用户既有历史正在这里（旧 8 列会被 appendRecord 自动补上「模式」列）。
 *
 * 另加一处增值（非必需）：把 SKILL.md 注册成 DSH 技能，使技能清单与 /history-taking-exam 可用。
 * ------------------------------------------------------------------ */