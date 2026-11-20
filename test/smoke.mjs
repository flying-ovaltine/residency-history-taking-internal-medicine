/**
 * 自检：`node --test test/smoke.mjs`（纯 JS，无需构建）。
 *
 * 用一个假宿主跑一遍真实插件：注册 5 个工具 + 1 个技能，
 * 再实际开一场考试、验阶段隔离、取实战手册、收卷落记录、看统计。
 * 每个用例用自己的临时记录文件，互不影响。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const plugin = await import('../index.js')

const tmp = mkdtempSync(join(tmpdir(), 'osce-v14-'))
let seq = 0
/** 每个用例一个独立记录文件 */
const rec = () => join(tmp, 'records-' + String(++seq) + '.md')

process.on('exit', () => {
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

function boot(file) {
  const tools = []
  const skills = []
  const ctx = {
    tools: { register(def) { tools.push(def); return () => {} } },
    get(name) {
      return name === 'skills' ? { register(skill) { skills.push(skill); return () => {} } } : undefined
    },
    logger: { warn() {} },
    on() {},
  }
  plugin.apply(ctx, { recordsFile: file })
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  return { tools, skills, byName }
}

test('注册 5 个工具与 1 个技能', () => {
  const { tools, skills } = boot(rec())
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'osce_finish', 'osce_get_case', 'osce_rules', 'osce_start', 'osce_stats',
  ])
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'history-taking-exam')
  assert.ok(skills[0].content.includes('口令'))
  assert.equal(skills[0].resourceBase.kind, 'directory')
  for (const t of tools) {
    assert.equal(typeof t.execute, 'function')
    assert.equal(typeof t.description, 'string')
    assert.equal(typeof t.output.render, 'function')
  }
})

test('开考返回开场 + SP 脚本，且不含标准病历', async () => {
  const { byName } = boot(rec())
  const text = await byName.osce_start.execute({ mode: 'normal' })
  assert.match(text, /【考站：病人接诊 · 病史采集】/)
  assert.match(text, /抽到：第 \d{2} 题/)
  assert.ok(!text.includes('## 五、标准病历'), 'SP 阶段不应出现标准病历')
  assert.match(text, /【本轮铁律/)
})

test('实战模式：开场不给题号，且叠加隐瞒规则', async () => {
  const { byName } = boot(rec())
  const text = await byName.osce_start.execute({ mode: 'combat' })
  assert.match(text, /【实战模式 · 病史采集】/)
  assert.ok(!text.includes('抽到：'), '实战模式开场不应给题号')
  assert.match(text, /实战四条/)
})

test('阶段隔离：正在考的那一题不给考后内容', async () => {
  const { byName } = boot(rec())
  const start = await byName.osce_start.execute({ mode: 'normal' })
  const no = (start.match(/抽到：第 (\d{2}) 题/) || [])[1]
  assert.ok(no, '没解析到题号')
  const blocked = await byName.osce_get_case.execute({ no, stage: 'grading' })
  assert.match(blocked, /现在不能给/)
  assert.ok(!blocked.includes('## 五、标准病历'))
  const other = await byName.osce_get_case.execute({ no: no === '01' ? '02' : '01', stage: 'grading' })
  assert.ok(other.includes('## 五、标准病历'), '非当前题应能给完整病例')
})

test('手册按需取：rubric 有标准分、combat 有实战规则、索引可列', async () => {
  const { byName } = boot(rec())
  const rubric = await byName.osce_rules.execute({ which: 'rubric' })
  assert.match(rubric, /标准分/)
  const combat = await byName.osce_rules.execute({ which: 'combat' })
  assert.ok(combat.length > 500)
  const index = await byName.osce_rules.execute({})
  assert.match(index, /persona/)
})

test('收卷：校验分数、写入记录、返回标准病历与评分表', async () => {
  const file = rec()
  const { byName } = boot(file)
  await byName.osce_start.execute({ mode: 'normal' })
  const bad = await byName.osce_finish.execute({ score: 120 })
  assert.match(bad, /score 必须/)
  const ok = await byName.osce_finish.execute({ score: 82, weakItems: '阴性鉴别、共情', durationMin: 18 })
  assert.match(ok, /【收卷 · 第 \d{2} 题/)
  assert.match(ok, /判定 通过/)
  assert.match(ok, /已写入训练记录/)
  assert.match(ok, /【官方 100 分评分表】/)
  assert.match(ok, /【该例标准病历（考后对照）】/)
  const raw = readFileSync(file, 'utf8')
  assert.match(raw, /\| 82 \| 通过 \|/)
  assert.match(raw, /普通/)
})

test('统计：空记录、单场、已练题号', async () => {
  const file = rec()
  const { byName } = boot(file)
  const empty = await byName.osce_stats.execute()
  assert.match(empty, /还没有训练记录/)
  await byName.osce_start.execute({ mode: 'normal' })
  await byName.osce_finish.execute({ score: 76 })
  const stat = await byName.osce_stats.execute()
  assert.match(stat, /总场次 1/)
  assert.match(stat, /总均分 76\.0/)
  assert.match(stat, /普通模式 1 场/)
})

test('没有 skills 服务时照样注册工具', () => {
  const tools = []
  const ctx = {
    tools: { register(d) { tools.push(d); return () => {} } },
    get() { return undefined },
    logger: { warn() {} },
    on() {},
  }
  assert.doesNotThrow(() => plugin.apply(ctx, { recordsFile: rec() }))
  assert.equal(tools.length, 5)
})
