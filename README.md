# 住培结业考病史采集陪练（内科）· DSH 插件

[English](README.en.md) | 中文

把「浙江省住培结业临床实践能力考核 · 病人接诊站 · 病史采集」这一站，在对话里完整跑一遍：

1. 说「**开始考试**」→ 插件抽题，模型立刻变成**标准化病人（SP）**，你当考生问诊；
2. 问完说「**结束考试**」→ 插件收卷、算用时、回溯你问过的每一句，模型切成**考官**，按官方 100 分表（18 行）逐项打分、给扣分点和可照抄的替换问句，最后给出该例标准病历对照；
3. 成绩自动追加到训练记录，下次开考先读它，优先抽你没练过的题。

**合格线 80 分，不是 60。** 这一站如此，插件里写死的就是 80。

> 仅用于考试训练与教学模拟，不构成医疗建议。病例、病人、检查结果均为虚构；病例是按官方建议病种与真实临床特征编写的训练脚本，不是泄题。

## 装上就能用

插件把三样东西一起装进你的 profile：

| 装了什么 | 内容 |
|---|---|
| **技能** `history-taking-exam` | 完整 SOP（口令规则、四模式、开场模板、考官输出顺序）+ **32 例病例脚本** + 4 份手册（评分表 / SP 扮演手册 / 考官评分手册 / 速查卡），原样随包分发 |
| **5 个工具** | `osce_start` / `osce_get_case` / `osce_rubric` / `osce_finish` / `osce_record`，把状态机、抽题、阶段隔离、落盘变成确定的机制 |
| **考官人设** | 「问渠」人设随包，考试进行中会注入一段很短的阶段约束（未开考时注入空串，不污染其他会话） |

### 安装

**方式一：插件市场（推荐）** — 打开 **插件 → 插件市场**，搜索「病史采集」或 `dsh-osce-history-internal-medicine`，点安装。

**方式二：本地目录（开发）**

```sh
dsh plugin --profile web add link:/absolute/path/to/residency-history-taking-internal-medicine
```

**方式三：手工挂 patch 层** — 把 `cordis.patch.yml` 里的 `insert` 段合并进 profile 的 `cordis.patch.yml`，然后重启宿主。patch 里的 `name` 必须与 `package.json` 的包名一致，否则整行静默不生效。

安装后**刷新页面**；工具注册是 Host 侧的，热加载后即可用。

## 怎么用

### 口令（最优先，压过一切流程描述）

| 你说 | 插件做什么 |
|---|---|
| 开始考试 / 开始 / 出题 / 来一道 / start exam | 抽题 → 加载病例 → 立刻进 SP 角色。**不确认、不问「准备好了吗」** |
| 结束考试 / 交卷 / 问完了 / 打分吧 / end exam | 停止扮演 → 切考官 → 出评分报告。**此后一句病人台词都不补** |
| 没说口令、继续问诊 | 当还在考试里，不自作主张收卷 |
| 点名专科或病种（「来一道血液的」「练个糖尿病」） | 在该子集内抽，优先没练过的题 |
| 「来一道血液的加练 / 清单外的」 | 抽 case-30～32，开场注明「清单外加练题」 |

### 四种模式

- **A 完整模拟**（默认）：抽题 → SP → 切考官 → 打分点评。
- **B 单点训练**：`osce_start` 传 `mode: "B"` 与 `focus`（如「只练总结」），只在该节点反复演练，不全程评分。
- **C 只出题**：`mode: "C"`，给题号、专科与角色设定，不扮演。
- **D 讲标准**：`mode: "D"`，不出题；直接讲评分表、问诊结构、常见漏项（数据源是 `osce_rubric`）。

### 工具

| 工具 | 作用 | 关键入参 |
|---|---|---|
| `osce_start` | 抽题、加载病例、记开始时间、切 SP；返回开场全文 + 本题 SP 可见内容 | `mode` `department` `disease` `caseNo` `extra` `focus` |
| `osce_get_case` | 读病例（长对话被压缩后重载）；**SP 阶段自动剥掉标准病历 / 考官提示** | `caseNo` `part`(`auto`/`sp`/`full`/`record`) |
| `osce_rubric` | 官方 100 分表片段：全文 / 考站规则 / 18 行明细 / 技巧标尺 / 高频漏项 / 高分画像 | `section` |
| `osce_finish` | 收卷：算用时、回溯本轮对白、返回标准病历 + 考官提示 + 评分表全文，阶段推到 GRADING | `questions`(降级用) `note` |
| `osce_record` | 写完分与判定、追加训练记录、返回累计场次 / 均分 / 已练题号 / 老毛病 | `score`(必填) `lostItems` `verdict` `minutes` `help` |

### 抽题规则（写在工具里，不靠模型自觉）

- 随机池只含 **case-01 ～ case-29**（考纲内 29 例，覆盖 30 个建议病种）。
- **case-30 ～ 32**（再障 / 骨髓瘤 / 淋巴瘤）是榜单外的血液加练，默认不进池，只有明确要求加练才抽，开场注明「清单外加练题」。
- 优先抽训练记录里没练过的题号；全练过了就随机。

### 阶段隔离（插件层面挡住，不是嘴上说说）

`osce_get_case` 在 SP 阶段请求「标准病历 / 诊断 / 鉴别要点」时，插件**只返回**角色卡 + 问诊分层 + 陷阱设计 + 既往史，`part` 被降级为 `sp` 并给出说明。这些考后内容只在 `osce_finish`（考官阶段）返回。

### 训练记录

- 位置：`~/.workbuddy/history-taking-records.md`（Windows 即 `%USERPROFILE%\.workbuddy\history-taking-records.md`），目录不存在会创建。
- 写不进去 → 退到会话工作目录的 `训练记录.md`；还不行 → **静默降级**，不报错、不中断点评，只在末尾说一句「这轮没能存进记录」。
- 只追加、不改写旧行；统计一律在读的时候现算。同一失分项出现 ≥3 次才叫「老毛病」。

## 会话历史怎么取（没有编造接口）

`osce_finish` 用 DSH 官方 `ctx.sessions` 服务回溯本轮对白：`Session.snapshotEvents(开考时的日志偏移)`，只取 `user/message` 与 `assistant/message` 两类事件。

取不到（服务缺失、会话不在内存、事件结构变化）时，退回到 `osce_finish` 的 `questions` 入参 —— 由模型把本轮问句逐条还原后传入。两条路都实现，**优先取历史**，并在工具返回里注明本轮来源（`会话日志自动回溯` / `模型提供的问句清单（降级）`）。

## 工程结构

```
residency-history-taking-internal-medicine/
├── package.json            # dsh.bundle.patch + exports（locale / icon）
├── cordis.patch.yml        # 挂载声明
├── tsconfig.json           # tsc → lib/
├── src/                    # TypeScript 源码（唯一真源）
│   ├── index.ts            # apply：注册技能 / 5 个工具 / 阶段约束
│   ├── tools.ts            # 五个工具的实现
│   ├── cases.ts            # 病例库：扫描、解析、抽题、阶段裁剪
│   ├── records.ts          # 训练记录：只追加 + 现算统计
│   ├── transcript.ts       # 会话日志回溯
│   ├── briefings.ts        # SP / 考官提示词与开场模板
│   ├── persona.ts          # 考官人设短提示
│   ├── state.ts            # 三阶段状态机（按会话隔离）
│   ├── resources.ts        # 资源定位（相对模块位置，可整体搬家）
│   ├── types.ts
│   └── dsh.d.ts            # 宿主包的**类型**声明（运行时零 import，见下）
├── lib/                    # 构建产物（随包分发）
├── resources/              # 中文素材，逐字节原样（40 个文件）
│   ├── agents/  avatars/  skills/history-taking-exam/{SKILL.md,references/*}
├── locale/zh.json en.json  # 插件市场的标题与简介
├── icon.png                # 512×512 头像
├── test/selfcheck.mjs      # 不连宿主的端到端自检
└── README.md / README.en.md / LICENSE
```

构建与自检：

```sh
pnpm install
pnpm build          # tsc -p tsconfig.json → lib/
pnpm typecheck
node --test test/selfcheck.mjs
```

## 实现说明（两处刻意的取舍）

1. **运行时零依赖，只 import 类型。**
   宿主把 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools` 打在应用自己的包里，**不装进 profile 的 node_modules**（本机实测：profile 里没有任何 `@deepseek-ai/*`）。插件若在运行时 `import` 它们，会解析失败并让宿主启动失败。所以源码只写 `import type`（编译后不留 import），运行时用 `ctx.tools.register(<与 ToolDefinition 同结构的纯对象>)` 注册 —— 这也是本机 `dsh-ppt` 等已装插件的做法。

2. **状态只在内存里。**
   半场考试的状态比没有状态更容易误导人：进程重启就清零，重开一局即可。训练记录是落盘的，成绩不会丢。

## 与输入规格的差异（如实交代）

- 规格要求 `src/index.ts`，已满足；`types/` 下的环境声明最后并入 `src/dsh.d.ts`（`tsc` 的 `rootDir` 只允许 src，否则编译报 TS6059）。
- 规格建议的工具名全部保留（`osce_start` / `osce_get_case` / `osce_rubric` / `osce_finish`），额外增加 `osce_record` 专门负责「落盘成绩」：写完分才记分，比让 `osce_finish` 既要收卷又要等一个还没打出来的分数更干净。
- 规格的「阶段迁移 SP → GRADING → IDLE」按字面实现：`osce_finish` 进 GRADING（此时还能要标准病历），`osce_record` 记完回 IDLE；IDLE 之后再调 `osce_finish` 会明确回「没有进行中的考试」。

## 许可

MIT © 杨杨。病例、手册与人设素材随本插件一同分发，来源为同作者的住培结业考病史采集专家包。

## 想上架到插件市场？

`marketplace/` 里已经备好了全部上架材料：`entry.yml`（awesome-dsh-plugin 的条目文件，改成你的 `<owner>` 即可）、`PR-body.md`（PR 描述）、`README.md`（建仓 → 发 Release → 提 PR 的完整命令）。

市场列表来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的 `data/plugins/<owner>__<repo>.yml`——一次 PR 只加这一个文件。前置条件是：仓库声明了 `dsh.bundle`（本插件已声明 ✅）、仓库创建满 1 天、加 `dsh-plugin` topic。包名 `dsh-osce-history-internal-medicine` 在 npm 上尚未被占用。

本机没有 `git`、`gh`、npm token，所以**实际的 push 与 PR 需要你自己的 GitHub 账号执行**；插件本身已经在本机装好可用。

