/**
 * 自检脚本：`node --test test/selfcheck.mjs`（需先 `pnpm build`）。
 *
 * 不连真宿主，用一个假的 Context 把五个工具完整跑一遍：
 * 抽题 → SP 阶段防护 → 评分表 → 收卷回溯对白 → 写训练记录 → 累计统计。
 * 训练记录写在临时目录（改 USERPROFILE），不碰使用者真实的 ~/.workbuddy。
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandboxHome = mkdtempSync(join(tmpdir(), 'osce-home-'))
process.env.USERPROFILE = sandboxHome
process.env.HOME = sandboxHome

const cases = await import('../lib/cases.js')
const records = await import('../lib/records.js')
const transcriptModule = await import('../lib/transcript.js')
const toolsModule = await import('../lib/tools.js')
const plugin = await import('../lib/index.js')

after(() => {
  rmSync(sandboxHome, { recursive: true, force: true })
})

/** 假会话：两条对白 + 当前日志偏移。 */
const session = {
  header: { cwd: sandboxHome },
  seq: 42,
  snapshotEvents() {
    return [
      {
        type: 'user/message',
        seq: 43,
        data: { role: 'user', content: [{ type: 'text', text: '您好，我是内科住院医师，先跟您核对一下信息，怎么称呼您？' }] },
      },
      {
        type: 'assistant/message',
        seq: 44,
        data: { message: { role: 'assistant', content: [{ type: 'text', text: '我姓王，四十二了。' }] } },
      },
      {
        type: 'user/message',
        seq: 45,
        data: { role: 'user', content: [{ type: 'text', text: '胸闷是在什么情况下出现的？' }] },
      },
    ]
  },
}

const sessionsService = { get: (id) => (id === 's1' ? session : undefined) }

/** 假 Context：记录注册了什么，并提供 sessions 服务。 */
function fakeContext(options = {}) {
  const registered = []
  const skills = []
  const prompts = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    skills: {
      register(skill) {
        skills.push(skill)
        return () => {}
      },
    },
    get(name) {
      if (name === 'sessions') {
        if (options.sessions === false) return undefined
        if (options.session !== undefined) return { get: () => options.session }
        return sessionsService
      }
      return undefined
    },
    inject(names, callback) {
      if (names.includes('systemPrompt') && options.systemPrompt === true) {
        callback({
          get: () => ({
            context(input) {
              prompts.push(input)
              return () => {}
            },
          }),
        })
      }
    },
    on() {},
    logger: { warn() {} },
  }
  return { ctx, registered, skills, prompts }
}

test('病例库：32 例、题号连续、元信息解析正确', async () => {
  const catalog = await cases.loadCatalog()
  assert.equal(catalog.length, 32)
  assert.deepEqual(
    catalog.map((item) => item.no),
    Array.from({ length: 32 }, (_, index) => index + 1),
  )
  const first = catalog[0]
  assert.equal(first.name, '缺铁性贫血')
  assert.equal(first.department, '血液内科')
  assert.equal(first.departmentShort, '血液')
  assert.equal(first.disease, '贫血')

  const iga = catalog.find((item) => item.no === 26)
  assert.equal(iga.name, '原发性肾小球肾炎（IgA 肾病）')
  assert.equal(iga.department, '肾脏内科')

  const combo = catalog.find((item) => item.no === 12)
  assert.equal(combo.department, '感染科 / 消化内科')
})

test('阶段防护：SP 视角不含标准病历与考官提示', async () => {
  const full = await cases.readCase(1)
  assert.ok(full !== undefined)
  const sp = cases.spView(full)
  assert.ok(sp.includes('SP 角色卡'))
  assert.ok(sp.includes('问诊分层'))
  assert.ok(sp.includes('陷阱设计'))
  assert.ok(!sp.includes('## 五、标准病历'))
  assert.ok(!sp.includes('## 六、考官提示'))
  assert.ok(full.text.includes('## 五、标准病历'))
  assert.ok(cases.standardRecord(full).includes('主诉'))
  assert.ok(cases.examinerNotes(full).includes('考官提示'))
})

test('抽题：优先未练过、加练只出 30–32、清单外默认不进池', async () => {
  const practiced = new Set(Array.from({ length: 29 }, (_, index) => index + 1).filter((no) => no !== 5))
  const fresh = await cases.pickCase({ practiced })
  assert.equal(fresh.meta.no, 5)
  assert.equal(fresh.reason, 'unpracticed')

  for (let index = 0; index < 20; index += 1) {
    const random = await cases.pickCase({})
    assert.ok(random.meta.no >= 1 && random.meta.no <= 29)
  }

  const extra = await cases.pickCase({ extra: true })
  assert.ok(extra.meta.no >= 30 && extra.meta.no <= 32)
  assert.equal(extra.reason, 'extra')

  const pointed = await cases.pickCase({ caseNo: 30 })
  assert.equal(pointed.meta.no, 30)
  assert.equal(pointed.reason, 'extra')
})

test('训练记录：解析、统计、追加与回读', async () => {
  const sample = [
    '# 病史采集训练记录',
    '',
    '| 日期时间 | 题号 | 病种 | 总分 | 判定 | 主要失分项 | 用时 | 求助 |',
    '|---|---|---|---|---|---|---|---|',
    '| 2026-11-16 21:10 | 03 | 稳定型心绞痛 | 82 | 通过 | 吸烟包年、用药依从性 | 18 min | 0 |',
    '| 2026-11-17 09:00 | 03 | 稳定型心绞痛 | 76 | 临界 | 吸烟包年、总结复述 | 20 min | 1 |',
    '',
  ].join('\n')
  const rows = records.parseRecords(sample)
  assert.equal(rows.length, 2)
  const summary = records.summarize(rows)
  assert.equal(summary.sessions, 2)
  assert.equal(summary.average, 79)
  assert.deepEqual(summary.practiced, [3])
  assert.equal(summary.lostCounts['吸烟包年'], 2)
  assert.deepEqual(summary.oldHabits, [])

  const third = records.parseRecords(`${sample}| 2026-11-18 09:00 | 03 | 稳定型心绞痛 | 78 | 临界 | 吸烟包年 | 19 min | 0 |\n`)
  assert.deepEqual(records.summarize(third).oldHabits, ['吸烟包年'])

  const written = await records.appendRecord({
    at: '2026-11-16 21:10',
    caseNo: 7,
    disease: '2 型糖尿病',
    score: 84,
    verdict: '通过',
    lost: '体重变化',
    minutes: 16,
    help: 0,
  })
  assert.equal(written.ok, true)
  assert.ok(written.path.endsWith('history-taking-records.md'))
  const back = await records.readRecords()
  assert.equal(back.summary.sessions, 1)
  assert.equal(back.rows[0].caseNo, 7)
})

test('判定口径：80 通过 / 70–79 临界 / <70 不通过', () => {
  assert.equal(toolsModule.verdictOf(80), '通过')
  assert.equal(toolsModule.verdictOf(79.5), '临界')
  assert.equal(toolsModule.verdictOf(70), '临界')
  assert.equal(toolsModule.verdictOf(69.9), '不通过')
})

test('会话回溯：从 user/assistant 事件里取对白', () => {
  const result = transcriptModule.extractTranscript(session, 42)
  assert.ok(result !== undefined)
  assert.equal(result.turns.length, 3)
  assert.equal(result.turns[0].role, 'candidate')
  assert.equal(result.turns[1].role, 'patient')
  assert.equal(transcriptModule.candidateCount(result), 2)
  assert.ok(transcriptModule.renderTranscript(result).includes('考生'))
})

test('会话回溯：运行时注入与超长文本被滤掉，不算问诊', () => {
  const noisy = {
    seq: 1,
    snapshotEvents: () => [
      {
        type: 'user/message',
        seq: 2,
        data: { role: 'user', content: [{ type: 'text', text: 'Current runtime context\nCurrent working directory: C:\\x' }] },
      },
      {
        type: 'user/message',
        seq: 3,
        data: { role: 'user', content: [{ type: 'text', text: '<system-reminder>别说话</system-reminder>' }] },
      },
      {
        type: 'user/message',
        seq: 4,
        data: { role: 'user', content: [{ type: 'text', text: '您这半年有没有觉得心慌？' }] },
      },
      {
        type: 'assistant/message',
        seq: 5,
        data: { message: { content: [{ type: 'text', text: '有，上楼梯最明显。' }] } },
      },
    ],
  }
  const result = transcriptModule.extractTranscript(noisy, 1)
  assert.ok(result !== undefined)
  assert.equal(result.skipped, 2)
  assert.equal(result.turns.length, 2)
  assert.equal(transcriptModule.candidateCount(result), 1)
  assert.ok(transcriptModule.renderTranscript(result).includes('运行时注入'))
})

test('收卷：日志里只有注入、没有问句时，明确标注 session-empty', async () => {
  const onlyNoise = {
    header: { cwd: sandboxHome },
    seq: 7,
    snapshotEvents: () => [
      {
        type: 'user/message',
        seq: 8,
        data: { role: 'user', content: [{ type: 'text', text: 'Current runtime context: 这里是运行时注入' }] },
      },
    ],
  }
  const { ctx, registered } = fakeContext({ session: onlyNoise })
  plugin.apply(ctx, {})
  const tool = (name) => registered.find((definition) => definition.name === name)
  const exec = { agent: { id: 's9' } }
  await tool('osce_start').execute({ caseNo: 6 }, exec)
  const finished = await tool('osce_finish').execute({}, exec)
  assert.equal(finished.transcriptSource, 'session-empty')
  assert.ok(finished.text.includes('没有捕捉到考生问句'))
})

test('注册：5 个工具 + 1 个技能，schema 与 render 合规', () => {
  const { ctx, registered, skills } = fakeContext()
  plugin.apply(ctx, {})
  assert.deepEqual(
    registered.map((definition) => definition.name).sort(),
    ['osce_finish', 'osce_get_case', 'osce_record', 'osce_rubric', 'osce_start'],
  )
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'history-taking-exam')
  assert.ok(skills[0].content.includes('口令规则'))
  assert.deepEqual(skills[0].resourceBase.kind, 'directory')

  for (const definition of registered) {
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.output.schema, 'object')
    const blocks = definition.output.render({}, { text: '示例' })
    assert.equal(blocks[0].type, 'text')
    assert.equal(blocks[0].text, '示例')
  }
})

test('端到端：开考 → 阶段防护 → 评分表 → 收卷 → 落盘', async () => {
  const { ctx, registered } = fakeContext()
  plugin.apply(ctx, {})
  const tool = (name) => registered.find((definition) => definition.name === name)
  const exec = { agent: { id: 's1' } }

  const started = await tool('osce_start').execute({ caseNo: 3 }, exec)
  assert.equal(started.ok, true)
  assert.equal(started.stage, 'SP')
  assert.equal(started.caseNo, 3)
  assert.match(started.opening, /第 03 题（心血管）/)
  assert.match(started.opening, /结束考试/)
  assert.ok(!started.opening.includes('标准病历'))
  assert.ok(!started.opening.includes('准备好了吗'))
  assert.ok(started.text.includes('SP 角色卡'))
  assert.ok(!started.text.includes('## 五、标准病历'))

  const blocked = await tool('osce_get_case').execute({ part: 'full' }, exec)
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.part, 'sp')
  assert.ok(!blocked.text.includes('## 五、标准病历'))

  const rubric = await tool('osce_rubric').execute({ section: 'rows' }, exec)
  assert.equal(rubric.passLine, 80)
  assert.ok(rubric.text.includes('标准分'))

  const finished = await tool('osce_finish').execute({}, exec)
  assert.equal(finished.ok, true)
  assert.equal(finished.transcriptSource, 'session')
  assert.equal(finished.elapsedMinutes >= 1, true)
  assert.ok(finished.text.includes('【已收卷'))
  assert.ok(finished.text.includes('18 行'))
  assert.ok(finished.text.includes('标准病历'))
  assert.ok(finished.text.includes('体育锻炼') || finished.text.includes('病史'))

  const again = await tool('osce_finish').execute({}, exec)
  assert.equal(again.ok, true)
  assert.equal(again.transcriptSource, 'already-graded')

  const recorded = await tool('osce_record').execute({ score: 82, lostItems: '总结复述、医保费用' }, exec)
  assert.equal(recorded.ok, true)
  assert.equal(recorded.verdict, '通过')
  assert.ok(recorded.sessions >= 1)
  assert.ok(recorded.text.includes('训练记录'))

  const afterRecord = await tool('osce_finish').execute({}, exec)
  assert.equal(afterRecord.ok, false)
  assert.ok(afterRecord.text.includes('没有进行中的考试'))
})

test('降级：没有 sessions 服务时用 questions 入参', async () => {
  const { ctx, registered } = fakeContext({ sessions: false })
  plugin.apply(ctx, {})
  const tool = (name) => registered.find((definition) => definition.name === name)
  const exec = { agent: { id: 's2' } }

  const started = await tool('osce_start').execute({ extra: true }, exec)
  assert.equal(started.ok, true)
  assert.ok(started.caseNo >= 30)
  assert.match(started.opening, /清单外加练题/)

  const finished = await tool('osce_finish').execute({ questions: ['怎么称呼您？', '胸闷多久了？'] }, exec)
  assert.equal(finished.ok, true)
  assert.equal(finished.transcriptSource, 'param')
  assert.ok(finished.text.includes('胸闷多久了'))
})

test('模式 D：不抽题，只讲标准', async () => {
  const { ctx, registered } = fakeContext()
  plugin.apply(ctx, {})
  const result = await registered.find((definition) => definition.name === 'osce_start').execute({ mode: 'D' }, { agent: { id: 's3' } })
  assert.equal(result.stage, 'IDLE')
  assert.ok(result.text.includes('模式 D'))
})
