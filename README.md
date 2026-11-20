# 住培病史采集陪练（内科）· DSH 插件

[English](README.en.md) | 中文 · **v1.4.0**

把「浙江省住培结业临床实践能力考核 · 病人接诊站 · 病史采集」这一站，在对话里完整跑一遍：

1. 说「**开始考试**」→ 插件抽题，模型立刻变成**标准化病人（SP）**，你当考生问诊；
2. 问完说「**结束考试**」→ 插件收卷、算用时、把成绩写进训练记录，模型切成**考官**，按官方 100 分表（18 行）逐项打分、给扣分点和可照抄的替换问句，最后给出该例标准病历对照；
3. 下次开考先读记录，优先抽你没练过的题。

**合格线 80 分，不是 60。** 这一站如此，插件里写死的就是 80。

> 仅用于考试训练与教学模拟，不构成医疗建议。病例、病人、检查结果均为虚构；病例是按官方建议病种与真实临床特征编写的训练脚本，不是泄题。

## v1.4.0 新增：实战模式

普通模式是「考站模拟」；**实战模式**是「真实门诊」——病人会藏：

- 开场只给一句问候，**不给题号、不给专科、不给主诉**；
- 病史只给最近这一次，追问才一层层往回剥（「咳嗽 5 年加重 1 天」→ 先只说「咳嗽，昨天开始的」）；
- 慢性病 / 用药 / 家族 / 传染病四类，第一次问一律轻描淡写或否认，追到具体才认；
- 检查单不主动展示：问「带了没」才承认、追「能给我看看吗」才拿出来；脚本里没有的检查一律「没查」，绝不现编；
- 不限时，不催不提示；病人是「急」不是「冷脸」。

记录表新增「模式」列，**普通 / 实战分开统计**；旧的 8 列记录会自动补表头，但已写入的行原样不动（缺末格按普通模式算）。

## 装了之后有什么

| 装了什么 | 内容 |
|---|---|
| **技能** `history-taking-exam` | 完整 SOP（口令、四模式、开场模板、考官输出顺序），技能清单里搜得到，也能 `/history-taking-exam` 直接调 |
| **5 个工具** | `osce_start` / `osce_get_case` / `osce_rules` / `osce_finish` / `osce_stats` |
| **素材** | 32 例病例脚本（考纲内 29 例 + 血液加练 3 例）+ 官方 100 分表 + 5 份手册（SP 扮演 / 实战模式 / 考官评分 / 速查卡 / 人设） |

## 五个工具

| 工具 | 作用 |
|---|---|
| `osce_start` | 抽题、读脚本、记开始时间，返回开场抬头 + 该例 SP 脚本（**不含**标准病历）。`mode: 'combat'` 走实战模式 |
| `osce_get_case` | 读指定病例；**考试中取同一题的考后内容会被拒绝**（防剧透硬约束） |
| `osce_rules` | 按需取手册：`persona` / `sp` / `combat` / `examiner` / `rubric` / `quick` / `skill`；不填返回索引 |
| `osce_finish` | 收卷：写记录、返回标准病历 + 官方评分表全文 + 判定口径（分数由你按 18 行判） |
| `osce_stats` | 场次、总均分、普通/实战分模式均分、已练题号、老毛病（同一失分项 ≥3 次） |

## 训练记录

- 默认路径：`~/.workbuddy/history-taking-records.md`（与规格一致；可用 patch 的 `config.recordsFile` 改）
- 只追加不改写；表头 9 列（末列「模式」），旧 8 列文件会被就地补表头
- 写不进去 → 报告照出，并在报告里明说「没能存进记录」，不假装已记录

## 安装

```sh
dsh plugin --profile web add "https://github.com/flying-ovaltine/residency-history-taking-internal-medicine/releases/latest/download/dsh-osce-history-internal-medicine.tgz"
```

或在 **插件 → 插件市场** 搜「病史采集」。

## 工程结构

```
residency-history-taking-internal-medicine/
├── package.json          # dsh.bundle.patch + exports
├── cordis.patch.yml      # 挂载声明（行 id / 包名 / 可选 config）
├── index.js              # 5 个工具 + 状态 + 记录读写（纯 JS，无构建）
├── resources/            # 中文素材原样随包（43 个文件）
│   ├── agents/  avatars/
│   └── skills/history-taking-exam/{SKILL.md, references/*}
├── test/smoke.mjs        # 8 项自检：工具注册 / 开场 / 实战 / 阶段隔离 / 手册 / 收卷 / 统计
├── locale/  icon.png  assets/icon-180.png
└── README.md / README.en.md / LICENSE / marketplace/
```

```sh
node --test test/smoke.mjs
```

## 本版对上游 v1.4.0 的 DSH 适配（只改三处，不动业务逻辑）

1. **去掉 `@deepseek-ai/schemastery` 与 `export const Config`**：本机 profile 的 `node_modules` 里没有 `@deepseek-ai/*`，运行时 import 会 `ERR_MODULE_NOT_FOUND`（实测装上直接 activate 失败）。配置改为 `apply` 内默认值 + patch 的 `config` 覆盖。
2. **`defineTool` 换成等价的本地恒等函数**：宿主只校验 `ToolDefinition` 结构。
3. **记录默认路径改回 `~/.workbuddy/history-taking-records.md`**，与规格一致，也保证你既有历史（旧 8 列）继续可读。

另加一处非必需增值：把 `SKILL.md` 注册成 DSH 技能，使技能清单与 `/history-taking-exam` 可用（宿主没有 `skills` 服务时静默跳过）。

## 已上架插件市场

本插件已被 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 目录收录：

- 市场页：https://awesome-dsh-plugin.com/p/flying-ovaltine/residency-history-taking-internal-medicine/
- 条目文件：`data/plugins/flying-ovaltine__residency-history-taking-internal-medicine.yml`

## 许可

MIT © 杨杨。病例、手册与人设素材随本插件一同分发，来源为同作者的住培结业考病史采集专家包。
