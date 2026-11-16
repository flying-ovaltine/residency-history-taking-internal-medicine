# 上架 dsh 插件市场（awesome-dsh-plugin）

插件本机已经装好、可用。**上架**指的是往 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提一个 PR，加**一个文件**：

```
data/plugins/<owner>__<repo>.yml
```

市场列表、awesome-dsh-plugin.com、dsh-market 插件的「发现」页都从这份数据生成，PR 合并后（通常一天内）自动出现在市场里。**不要再提交 npm 包名或 README 行**——一个 YAML 文件就是全部投稿。

## 0. 前置条件（缺一不可）

| 条件 | 现状 |
|---|---|
| 一个 GitHub 仓库，根目录的 `package.json` 声明 `dsh.bundle` | ✅ 本目录已声明（`dsh.bundle.patch`） |
| 仓库里有 `cordis.patch.yml` | ✅ 已就位 |
| 仓库创建满 **1 天** | ⏳ 建仓后等一天 |
| 仓库加 `dsh-plugin` topic | ⏳ 建仓后加 |
| 代码真实可用（不是占位/纯 README） | ✅ 5 个工具 + 端到端自检 12 项全过 |
| 描述属实、不带营销词、以句号结尾 | ✅ 见下面的 entry |

本机**没有** `git`、`gh`、npm token，所以我没法替你把仓库推上去、也没法开 PR。下面命令在装了 git/gh 的机器上跑。

## 1. 建仓库并推上去

仓库名建议就用 `residency-history-taking-internal-medicine`（条目文件名要跟着它走）。

```sh
cd residency-history-taking-internal-medicine
git init -b main
git add -A
git commit -m "feat: residency OSCE history-taking trainer (internal medicine)"
gh repo create <owner>/residency-history-taking-internal-medicine --public --source=. --push
gh repo edit <owner>/residency-history-taking-internal-medicine --add-topic dsh-plugin
```

> `node_modules/`、`*.tgz` 已在 `.gitignore` 里；`lib/` 是构建产物，**要提交**（市场按仓库源码安装时 `main` 指向 `lib/index.js`）。

## 2. （推荐）发一个 GitHub Release，附预构建 tarball

装的人可以免掉 `allowBuilds` 构建授权，市场下载也快。资产名**不要带版本号**，否则下次发版 `latest/download/` 的链接会 404：

```sh
cp dsh-osce-history-internal-medicine-1.0.0.tgz ../dsh-osce-history-internal-medicine.tgz
gh release create v1.0.0 ../dsh-osce-history-internal-medicine.tgz \
  --title "v1.0.0" --notes "首个版本：5 个工具 + 技能 + 32 例病例脚本"
```

## 3. 提 PR：只加一个文件

Fork `awesome-dsh-plugin/awesome-dsh-plugin`，把 `entry.yml` 改好（把 `<owner>` 换成你的 GitHub 账号），放到：

```
data/plugins/<owner>__residency-history-taking-internal-medicine.yml
```

```sh
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
mkdir -p data/plugins
cp /path/to/entry.yml data/plugins/<owner>__residency-history-taking-internal-medicine.yml
git checkout -b add-residency-history-taking-internal-medicine
git add data/plugins
git commit -m "Add <owner>/residency-history-taking-internal-medicine"
git push -u origin add-residency-history-taking-internal-medicine
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --title "Add <owner>/residency-history-taking-internal-medicine" \
  --body-file /path/to/PR-body.md
```

CI 会检查：条目数量（≤3）、`dsh.bundle`、仓库年龄、awesome-lint 与 README 能否重新生成。失败会明确说改什么，**在同一分支上推修复即可，不用重开 PR**。

## 4. （可选）发 npm，让市场能显示下载量

```sh
npm publish --access public
```

- 发之前把 `package.json` 的 `repository` 字段指向这个 GitHub 仓库（否则 npm 包与条目不会关联）。
- 包名 `dsh-osce-history-internal-medicine` 目前**在 npm 上未被占用**（registry 返回 404）。
- 不发也不影响收录，只是没有下载量数字。

## 常见的被打回原因（这个插件怎么避开的）

- 只声明 `dsh.client`、没有 `dsh.bundle` → 本插件是 Host-only bundle，没有 `dsh.client`。
- 描述夸大（写"46 个工具"结果真没有）→ 条目里只写 5 个工具、32 例病例、100 分表，全部可核对。
- 仓库刚建几分钟 → 等满 1 天再提。
- 手工改生成出来的 README → 本指南只让你加 `data/plugins/*.yml`。
