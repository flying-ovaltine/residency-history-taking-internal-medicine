/**
 * 五个工具的实现（对话就是界面，所以全部是 Host 侧工具，不做独立的客户端面板）。
 *
 *   osce_start     抽题 → 加载病例 → 记开始时间 → 切 SP，返回开场 + SP 可见内容
 *   osce_get_case  读指定病例，做**阶段防护**：SP 阶段拿不到标准病历 / 诊断 / 鉴别
 *   osce_rubric    返回官方 100 分表的指定片段
 *   osce_finish    收卷 → 算用时 → 回溯本轮对白 → 切 GRADING，返回标准病历与评分表
 *   osce_record    写完分与判定 → 追加训练记录 → 回 IDLE，返回累计统计
 *
 * 所有工具都有 `text` 字段，它就是模型实际看到的那段话；其余字段是结构化数据。
 */
import { examinerBrief, modeDNotice, openingBlock, sessionLine, spBrief } from './briefings.js';
import { examinerNotes, findCase, loadCatalog, openingAction, pickCase, readCase, roleCard, spView, standardRecord, } from './cases.js';
import { appendRecord, readRecords, timestamp } from './records.js';
import { HANDBOOKS, readText, referencesDir } from './resources.js';
import { beginExam, getState, markGrading, markIdle, setState, stageLabel, stateKey } from './state.js';
import { candidateCount, extractTranscript, renderTranscript } from './transcript.js';
import { join } from 'node:path';
/** 合格线：这一站是 80 分，不是 60。 */
export const PASS_LINE = 80;
/** 文本块快捷构造。 */
function textBlock(text) {
    return [{ type: 'text', text }];
}
/** 从参数里取非空字符串。 */
function asString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
/** 从参数里取数字（容忍字符串数字）。 */
function asNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
/** 从参数里取布尔。 */
function asBoolean(value) {
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'string')
        return ['true', '1', 'yes', '是'].includes(value.toLowerCase());
    return false;
}
/** 从参数里取字符串数组。 */
function asStringArray(value) {
    if (Array.isArray(value)) {
        return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item !== '');
    }
    const single = asString(value);
    return single === undefined ? [] : [single];
}
/** 归一模式：只认 A/B/C/D，默认 A。 */
function asMode(value) {
    const raw = asString(value)?.toUpperCase();
    return raw === 'B' || raw === 'C' || raw === 'D' ? raw : 'A';
}
/** 分数 → 判定（口径固定）。 */
export function verdictOf(score) {
    if (score >= PASS_LINE)
        return '通过';
    if (score >= 70)
        return '临界';
    return '不通过';
}
/** 取当前会话对象（拿不到就 undefined）。 */
function sessionOf(ctx, exec) {
    const key = stateKey(exec.agent);
    if (key === '__global__')
        return undefined;
    const sessions = ctx.get('sessions');
    if (sessions === null || sessions === undefined || typeof sessions.get !== 'function')
        return undefined;
    try {
        return sessions.get(key);
    }
    catch {
        return undefined;
    }
}
/** 会话工作目录（训练记录的第二落点）。 */
function cwdOf(ctx, exec) {
    const cwd = sessionOf(ctx, exec)?.header?.cwd;
    if (typeof cwd === 'string' && cwd !== '')
        return cwd;
    try {
        return process.cwd();
    }
    catch {
        return undefined;
    }
}
/** 取会话当前日志偏移，作为本轮对白的起点。 */
function seqOf(session) {
    const seq = session?.seq;
    return typeof seq === 'number' && Number.isFinite(seq) ? seq : 0;
}
/** 读评分表全文。 */
async function readRubric() {
    const text = await readText(join(referencesDir, HANDBOOKS.rubric));
    return text ?? `（评分表读取失败：resources/skills/history-taking-exam/references/${HANDBOOKS.rubric} 缺失）`;
}
/** 按二级标题关键字切片 Markdown。 */
function sliceMarkdown(text, keywords) {
    if (keywords.length === 0)
        return text;
    const lines = text.split(/\r?\n/);
    const picked = [];
    let active = false;
    for (const line of lines) {
        if (line.startsWith('## ')) {
            active = keywords.some((keyword) => line.includes(keyword));
        }
        if (active)
            picked.push(line);
    }
    return picked.length > 0 ? picked.join('\n').trim() : text;
}
const RUBRIC_KEYWORDS = {
    all: [],
    rules: ['考站规则'],
    rows: ['评分表逐项拆解'],
    technique: ['技巧与沟通'],
    pitfalls: ['最容易丢'],
    profile: ['高分画像'],
};
/** 统计里最该点名的失分项（出现次数最多的前三个）。 */
function weakestItems(summary) {
    return Object.entries(summary.lostCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([item, count]) => `${item}（${count} 次）`);
}
/** 记录里「老毛病」那一段（≥3 次才写）。 */
function oldHabitLine(summary) {
    if (summary.oldHabits.length === 0)
        return '';
    return `老毛病（≥3 次）：${summary.oldHabits.join('、')}`;
}
/** 训练记录摘要（给模型看的内部信息，不写进开场）。 */
function trainingLine(summary) {
    if (summary.sessions === 0) {
        return '【训练记录】还没有历史场次（第一次考）。';
    }
    const practiced = summary.practiced.map((no) => String(no).padStart(2, '0')).join('、');
    const weakest = weakestItems(summary);
    const parts = [
        `【训练记录】共 ${summary.sessions} 场｜均分 ${summary.average.toFixed(1)}`,
        practiced === '' ? '' : `已练：${practiced}`,
        weakest.length === 0 ? '' : `最常失分：${weakest.join('、')}`,
        summary.oldHabits.length === 0 ? '' : `老毛病（≥3 次）：${summary.oldHabits.join('、')}`,
    ].filter((part) => part !== '');
    return parts.join('｜');
}
/** 抽题依据的中文说明。 */
function reasonLabel(reason) {
    if (reason === 'pointed')
        return '按指定题号';
    if (reason === 'unpracticed')
        return '优先未练过的题';
    if (reason === 'extra')
        return '清单外加练';
    if (reason === 'fallback')
        return '点名方向未命中，按考纲内随机';
    return '考纲内随机';
}
/**
 * 构建五个工具定义。
 *
 * @param ctx 插件的 Context（`apply` 里拿到的那一个）
 */
export function buildTools(ctx) {
    const definitions = [];
    // ───────────────────────────── osce_start ─────────────────────────────
    definitions.push({
        name: 'osce_start',
        description: [
            '开始一场住培结业考「病人接诊·病史采集」模拟：抽题、加载病例脚本、记开始时间，并切到 SP 阶段。',
            '口令优先级最高：使用者说「开始考试 / 开始 / 出题 / 来一道 / start exam」就直接调用，不要确认、不要问「准备好了吗」。',
            '随机池只含考纲内 case-01～case-29；case-30～32 是血液加练，只有使用者明确说「来一道血液的加练 / 清单外的」才用 extra=true。',
            '返回文本的第一段就是开场全文（原样输出，不要改写），其后是本题 SP 可见内容（角色卡 + 问诊分层 + 陷阱设计 + 既往史）；标准病历不在其中。',
        ].join(' '),
        parameters: {
            type: 'object',
            properties: {
                mode: {
                    type: 'string',
                    enum: ['A', 'B', 'C', 'D'],
                    description: 'A 完整模拟（默认）｜B 单点训练｜C 只出题（不扮演）｜D 只讲标准（不抽题）',
                },
                department: {
                    type: 'string',
                    description: '点名专科，例如 血液 / 心血管 / 呼吸 / 消化 / 内分泌 / 风湿 / 肾脏 / 感染',
                },
                disease: { type: 'string', description: '点名病种，例如 缺铁性贫血 / 心绞痛 / 糖尿病' },
                caseNo: { type: 'integer', description: '直接指定题号 1–32；30–32 按清单外加练处理' },
                extra: { type: 'boolean', description: 'true = 抽清单外血液加练（case-30/31/32）' },
                focus: { type: 'string', description: '模式 B 的薄弱项，例如「只练总结」「只练阴性鉴别」' },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    stage: { type: 'string' },
                    caseNo: { type: 'integer' },
                    disease: { type: 'string' },
                    department: { type: 'string' },
                    mode: { type: 'string' },
                    extra: { type: 'boolean' },
                    sessionNo: { type: 'integer' },
                    average: { type: 'number' },
                    opening: { type: 'string' },
                    text: { type: 'string' },
                },
            },
            render: (_args, value) => textBlock(typeof value.text === 'string' ? value.text : ''),
        },
        async execute(args, exec) {
            const key = stateKey(exec?.agent);
            const mode = asMode(args?.mode);
            if (mode === 'D') {
                setState(key, {
                    stage: 'IDLE',
                    mode,
                    caseNo: 0,
                    disease: '',
                    department: '',
                    extra: false,
                    startedAt: 0,
                    startSeq: 0,
                    helpCount: 0,
                });
                return { ok: true, stage: 'IDLE', mode, text: modeDNotice() };
            }
            const fallbackDir = cwdOf(ctx, exec);
            const records = await readRecords(fallbackDir);
            const session = sessionOf(ctx, exec);
            const wantedNo = asNumber(args?.caseNo);
            const picked = await pickCase({
                caseNo: wantedNo,
                department: asString(args?.department),
                disease: asString(args?.disease),
                extra: asBoolean(args?.extra),
                practiced: new Set(records.summary.practiced),
            });
            if (picked === undefined) {
                return {
                    ok: false,
                    stage: stageLabel(getState(key)?.stage ?? 'IDLE'),
                    text: [
                        '【开考失败】没有读到任何病例文件。',
                        `请检查插件资源是否完整：resources/skills/history-taking-exam/references/ 下应有 32 个 case-*.md。`,
                        '这一步不需要问使用者，直接告知资源缺失即可。',
                    ].join('\n'),
                };
            }
            const full = await readCase(picked.meta.no);
            if (full === undefined) {
                return {
                    ok: false,
                    stage: '未开考',
                    text: `【开考失败】第 ${picked.meta.no} 题的病例文件读不出来，请检查插件资源完整性。`,
                };
            }
            const sessionNo = records.summary.sessions + 1;
            const extra = picked.meta.no > 29;
            const focus = asString(args?.focus);
            const opening = openingBlock({
                meta: picked.meta,
                extra,
                // 第一次考不写「第 N 场」这一行；有历史时写「本场是第几场」。
                sessionNo: records.summary.sessions > 0 ? sessionNo : 0,
                average: records.summary.average,
                mode,
                focus,
                action: openingAction(full),
                reason: picked.reason,
            });
            if (mode === 'C') {
                setState(key, {
                    stage: 'IDLE',
                    mode,
                    caseNo: picked.meta.no,
                    disease: picked.meta.name,
                    department: picked.meta.department,
                    extra,
                    startedAt: Date.now(),
                    startSeq: seqOf(session),
                    helpCount: 0,
                });
                const text = [
                    '【模式 C · 只出题，不扮演】',
                    opening,
                    '',
                    '【角色设定（给使用者自己练）】',
                    roleCard(full),
                    '',
                    '说明：不扮演、不点评。使用者问你要问诊分层明细时，再调用 osce_get_case（SP 阶段防护对 IDLE 不生效）。',
                ].join('\n');
                return {
                    ok: true,
                    stage: 'IDLE',
                    caseNo: picked.meta.no,
                    disease: picked.meta.name,
                    department: picked.meta.department,
                    mode,
                    extra,
                    sessionNo,
                    average: records.summary.average,
                    opening,
                    text,
                };
            }
            beginExam(key, {
                mode,
                caseNo: picked.meta.no,
                disease: picked.meta.name,
                department: picked.meta.department,
                extra,
                startSeq: seqOf(session),
            });
            const body = [
                '【这条回复只输出下面这一段开场，原样输出，不要加任何别的话，尤其不要问「准备好了吗」】',
                opening,
                '',
                '———————— 以下演出资料只给你看，一个字都不许念给考生 ————————',
                '',
                spBrief(),
                '',
                trainingLine(records.summary),
                '',
                `【本题 SP 可见内容（题号 ${String(picked.meta.no).padStart(2, '0')} · ${picked.meta.name} · ${picked.meta.department} · 难度 ${picked.meta.difficulty}）】`,
                `抽题依据：${reasonLabel(picked.reason)}`,
                '',
                spView(full),
            ].join('\n');
            return {
                ok: true,
                stage: 'SP',
                caseNo: picked.meta.no,
                disease: picked.meta.name,
                department: picked.meta.department,
                mode,
                extra,
                sessionNo,
                average: records.summary.average,
                opening,
                text: body,
            };
        },
    });
    // ──────────────────────────── osce_get_case ────────────────────────────
    definitions.push({
        name: 'osce_get_case',
        description: [
            '读取一例病例脚本。默认按当前阶段裁剪：SP 阶段只返回角色卡、问诊分层、陷阱设计、既往史等前置内容；',
            '「标准病历」「考官提示」属于考后内容，SP 阶段请求会被插件挡住（part 被降级为 sp）。',
            '用于长对话被压缩后重新加载本题，或使用者点名要某一题。',
        ].join(' '),
        parameters: {
            type: 'object',
            properties: {
                caseNo: { type: 'integer', description: '题号 1–32；省略则用当前考试的题号' },
                part: {
                    type: 'string',
                    enum: ['auto', 'sp', 'full', 'record'],
                    description: 'auto 按阶段自动｜sp 只要角色卡与问诊分层｜full 全文｜record 只要标准病历（仅考官阶段）',
                },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    stage: { type: 'string' },
                    caseNo: { type: 'integer' },
                    part: { type: 'string' },
                    blocked: { type: 'boolean' },
                    text: { type: 'string' },
                },
            },
            render: (_args, value) => textBlock(typeof value.text === 'string' ? value.text : ''),
        },
        async execute(args, exec) {
            const key = stateKey(exec?.agent);
            const state = getState(key);
            const stage = state?.stage ?? 'IDLE';
            const wantedNo = asNumber(args?.caseNo) ?? (state !== undefined && state.caseNo > 0 ? state.caseNo : undefined);
            if (wantedNo === undefined) {
                return {
                    ok: false,
                    stage: stageLabel(stage),
                    text: '【没有指定题号】还没开考，也没有给 caseNo。请先 osce_start 抽题，或直接给出题号（1–32）。',
                };
            }
            const full = await readCase(wantedNo);
            if (full === undefined) {
                return { ok: false, stage: stageLabel(stage), caseNo: wantedNo, text: `【第 ${wantedNo} 题不存在】病例库只有 1–32，请换一个题号。` };
            }
            const requested = (asString(args?.part) ?? 'auto');
            let part = requested === 'auto' ? (stage === 'SP' ? 'sp' : 'full') : requested;
            let blocked = false;
            if (stage === 'SP' && (part === 'full' || part === 'record')) {
                blocked = true;
                part = 'sp';
            }
            if (part === 'record' && stage !== 'GRADING') {
                blocked = true;
                part = 'sp';
            }
            const header = `【第 ${String(full.no).padStart(2, '0')} 题 · ${full.name} · ${full.department} · 难度 ${full.difficulty}】`;
            const guard = blocked
                ? '【阶段防护】当前是 SP 阶段：标准病历 / 诊断 / 鉴别要点属于考后内容，插件已拦下。结束考试后 osce_finish 会给。\n\n'
                : '';
            const body = part === 'sp' ? spView(full) : part === 'record' ? standardRecord(full) : full.text;
            return {
                ok: true,
                stage: stageLabel(stage),
                caseNo: full.no,
                part,
                blocked,
                text: guard + header + '\n\n' + body,
            };
        },
    });
    // ───────────────────────────── osce_rubric ─────────────────────────────
    definitions.push({
        name: 'osce_rubric',
        description: [
            '返回浙江省住培结业考「病人接诊·病史采集」官方 100 分评分表（18 行）与判分标尺。',
            '合格线 80 分，不是 60。section 可选：all 全文｜rules 考站规则｜rows 18 行明细｜technique 技巧与沟通判分标尺｜pitfalls 高频漏项 33 分｜profile 高分画像。',
            '模式 D（只讲标准）与「这题怎么打分」这类问题都用它，不需要抽题。',
        ].join(' '),
        parameters: {
            type: 'object',
            properties: {
                section: {
                    type: 'string',
                    enum: ['all', 'rules', 'rows', 'technique', 'pitfalls', 'profile'],
                    description: '要哪一段，默认 all',
                },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    section: { type: 'string' },
                    passLine: { type: 'integer' },
                    text: { type: 'string' },
                },
            },
            render: (_args, value) => textBlock(typeof value.text === 'string' ? value.text : ''),
        },
        async execute(args) {
            const section = (asString(args?.section) ?? 'all');
            const valid = Object.keys(RUBRIC_KEYWORDS).includes(section) ? section : 'all';
            const full = await readRubric();
            const body = sliceMarkdown(full, RUBRIC_KEYWORDS[valid]);
            return {
                section: valid,
                passLine: PASS_LINE,
                text: `【病史采集评分表 · ${valid}】（合格线 ${PASS_LINE} 分——不是 60）\n\n${body}`,
            };
        },
    });
    // ───────────────────────────── osce_finish ─────────────────────────────
    definitions.push({
        name: 'osce_finish',
        description: [
            '收卷：停止扮演、停止一切病人台词，切到考官阶段。',
            '使用者说「结束考试 / 交卷 / 问完了 / 打分吧 / end exam」时直接调用，不要确认、不要补一句病人台词。',
            '本工具会算用时、从会话日志回溯本轮对白（取不到则用 questions 入参）、返回标准病历、考官提示与评分表全文，并把阶段推到 GRADING。',
            '之后按 examinerBrief 的顺序输出点评，最后调用 osce_record 落盘分数。',
        ].join(' '),
        parameters: {
            type: 'object',
            properties: {
                questions: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '降级用：读不到会话历史时，由模型还原的本场考生问句清单（逐条）',
                },
                note: { type: 'string', description: '本轮补充说明，例如「本轮含 2 次提示」' },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    stage: { type: 'string' },
                    caseNo: { type: 'integer' },
                    disease: { type: 'string' },
                    elapsedMinutes: { type: 'integer' },
                    transcriptSource: { type: 'string' },
                    passLine: { type: 'integer' },
                    text: { type: 'string' },
                },
            },
            render: (_args, value) => textBlock(typeof value.text === 'string' ? value.text : ''),
        },
        async execute(args, exec) {
            const key = stateKey(exec?.agent);
            const state = getState(key);
            if (state === undefined || state.caseNo <= 0) {
                return {
                    ok: false,
                    stage: '未开考',
                    text: '【当前没有进行中的考试】先 osce_start 抽题再开考；如果是要讲评分标准，直接用 osce_rubric。',
                };
            }
            if (state.stage === 'GRADING') {
                return {
                    ok: true,
                    stage: '考官点评中',
                    caseNo: state.caseNo,
                    disease: state.disease,
                    elapsedMinutes: state.pending?.elapsedMinutes ?? 0,
                    transcriptSource: 'already-graded',
                    passLine: PASS_LINE,
                    text: [
                        '【本轮已经收过卷】现在是考官阶段，不再补病人台词。',
                        `题号 ${String(state.caseNo).padStart(2, '0')} · ${state.disease}｜用时 ${state.pending?.elapsedMinutes ?? 0} 分钟。`,
                        '按 examinerBrief 的顺序出点评；打完分调用 osce_record 落盘。',
                    ].join('\n'),
                };
            }
            if (state.stage !== 'SP') {
                return {
                    ok: false,
                    stage: '未开考',
                    text: '【当前没有进行中的考试】先 osce_start 抽题开考；如果是要讲评分标准，直接用 osce_rubric。',
                };
            }
            const elapsedMinutes = Math.max(1, Math.round((Date.now() - state.startedAt) / 60000));
            const session = sessionOf(ctx, exec);
            const transcript = extractTranscript(session, state.startSeq);
            const manual = asStringArray(args?.questions);
            const full = await readCase(state.caseNo);
            const recordText = full === undefined ? '（标准病历读取失败）' : standardRecord(full);
            const notesText = full === undefined ? '（考官提示读取失败）' : examinerNotes(full);
            const rubric = await readRubric();
            let transcriptText;
            let source;
            const asked = transcript === undefined ? 0 : candidateCount(transcript);
            if (transcript !== undefined && asked > 0) {
                transcriptText = renderTranscript(transcript);
                source = 'session';
            }
            else if (manual.length > 0) {
                transcriptText = manual.map((item, index) => `${index + 1}. 【考生】${item}`).join('\n');
                source = 'param';
            }
            else if (transcript !== undefined) {
                transcriptText = [
                    renderTranscript(transcript),
                    '会话日志里没有捕捉到考生问句（可能本轮没有真正问诊，或问句被运行时注入挤掉）。',
                    '请凭本轮对话自行逐条还原考生问句，再按下面的评分表打分，并在报告里注明「按对话还原」。',
                ].join('\n');
                source = 'session-empty';
            }
            else {
                transcriptText = '（读不到会话日志，也没有提供问句清单：请凭本轮对话自行逐条还原，并注明「按对话还原」）';
                source = 'none';
            }
            markGrading(key, elapsedMinutes);
            const note = asString(args?.note);
            const text = [
                '【已收卷：停止扮演，切换到考官】',
                '从现在起一句病人台词都不能再补：不补最后一句、不解释为什么结束、不写「好的那我们结束」。',
                '',
                `题号 ${String(state.caseNo).padStart(2, '0')} · ${state.disease}（${state.department}）｜用时 ${elapsedMinutes} 分钟`,
                note === undefined ? '' : `本轮说明：${note}`,
                '',
                examinerBrief(),
                '',
                `【本轮问诊实录】（来源：${source === 'session'
                    ? '会话日志自动回溯'
                    : source === 'param'
                        ? '模型提供的问句清单（降级）'
                        : source === 'session-empty'
                            ? '会话日志里没有考生问句，需按对话还原'
                            : '读不到会话日志，需按对话还原'}）`,
                transcriptText,
                '',
                '【评分表全文（18 行，逐项打分用）】',
                rubric,
                '',
                '【本题标准病历（考后对照，给使用者自查）】',
                recordText,
                '',
                '【本题考官提示（判分要点）】',
                notesText,
                '',
                '最后一步：按 ③ 打完分后调用 osce_record（score 必填，lostItems 写主要失分项）把这一轮写进训练记录。',
            ]
                .filter((line) => line !== '')
                .join('\n');
            return {
                ok: true,
                stage: '考官点评中',
                caseNo: state.caseNo,
                disease: state.disease,
                elapsedMinutes,
                transcriptSource: source,
                passLine: PASS_LINE,
                text,
            };
        },
    });
    // ───────────────────────────── osce_record ─────────────────────────────
    definitions.push({
        name: 'osce_record',
        description: [
            '把本轮成绩追加进训练记录（~/.workbuddy/history-taking-records.md，只追加不改写），并返回累计场次、均分、已练题号与「老毛病」。',
            'score 必填：0–100，按官方 18 行逐项加总。判定口径固定：≥80 通过｜70–79 临界｜<70 不通过。',
            '写不进去会静默降级（ok=false，不报错不中断），此时在点评末尾加一句「这轮没能存进记录」。',
            '必须在 osce_finish 之后调用；它不是考试阶段的一部分，只是记账。',
        ].join(' '),
        parameters: {
            type: 'object',
            properties: {
                score: { type: 'number', description: '总分 0–100（必填）' },
                lostItems: { type: 'string', description: '主要失分项，1–3 项，用顿号分隔，写短名' },
                verdict: { type: 'string', enum: ['通过', '临界', '不通过'], description: '判定；省略时按分数自动判' },
                minutes: { type: 'integer', description: '用时（分钟）；省略时用 osce_finish 算出的值' },
                help: { type: 'integer', description: '本轮求助次数，默认 0' },
                caseNo: { type: 'integer', description: '题号；省略时用刚结束的那一轮' },
            },
            required: ['score'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    path: { type: 'string' },
                    caseNo: { type: 'integer' },
                    score: { type: 'number' },
                    verdict: { type: 'string' },
                    sessions: { type: 'integer' },
                    average: { type: 'number' },
                    text: { type: 'string' },
                },
            },
            render: (_args, value) => textBlock(typeof value.text === 'string' ? value.text : ''),
        },
        async execute(args, exec) {
            const key = stateKey(exec?.agent);
            const state = getState(key);
            const score = asNumber(args?.score);
            if (score === undefined || score < 0 || score > 100) {
                return { ok: false, text: '【分数无效】score 必须是 0–100 的数字，按 18 行逐项加总后传入。' };
            }
            const pending = state?.pending;
            const caseNo = asNumber(args?.caseNo) ?? pending?.caseNo ?? (state !== undefined && state.caseNo > 0 ? state.caseNo : undefined);
            if (caseNo === undefined) {
                return { ok: false, text: '【没有可记录的考试】先 osce_start 开考、osce_finish 收卷，再写记录。' };
            }
            const meta = await findCase(caseNo);
            const disease = pending?.disease ?? meta?.name ?? state?.disease ?? '未知';
            const minutes = asNumber(args?.minutes) ?? pending?.elapsedMinutes ?? 0;
            const help = asNumber(args?.help) ?? state?.helpCount ?? 0;
            const verdictRaw = asString(args?.verdict);
            const verdict = verdictRaw === '通过' || verdictRaw === '临界' || verdictRaw === '不通过' ? verdictRaw : verdictOf(score);
            const lost = asString(args?.lostItems) ?? '';
            const row = {
                at: timestamp(),
                caseNo,
                disease,
                score: Math.round(score * 10) / 10,
                verdict,
                lost: lost === '' ? '—' : lost,
                minutes: Math.max(0, Math.round(minutes)),
                help: Math.max(0, Math.round(help)),
            };
            const fallbackDir = cwdOf(ctx, exec);
            const written = await appendRecord(row, fallbackDir);
            const after = await readRecords(fallbackDir);
            const summary = after.summary;
            markIdle(key);
            const stats = [
                sessionLine(summary.sessions, summary.average) === '' ? '还没有历史场次' : sessionLine(summary.sessions, summary.average),
                `已练题号：${summary.practiced.length === 0 ? '无' : summary.practiced.map((no) => String(no).padStart(2, '0')).join('、')}`,
                weakestItems(summary).length === 0 ? '' : `最常失分：${weakestItems(summary).join('、')}`,
                oldHabitLine(summary),
            ].filter((line) => line !== '');
            const head = written.ok
                ? `【已写入训练记录】${written.path ?? ''}`
                : `【这轮没能存进记录】${written.reason ?? '写入失败'}`;
            const tail = written.ok ? '' : '请在点评末尾加一句「这轮没能存进记录，下次统计不会包含它」，不要报错、不要中断点评。';
            const text = [
                head,
                `第 ${String(caseNo).padStart(2, '0')} 题 · ${disease}｜${row.score} 分｜${verdict}｜用时 ${row.minutes} 分钟`,
                '',
                '【累计】',
                ...stats,
                '',
                '提醒口径：本插件只覆盖病史采集这一半（100 分）；官方考站是病史采集 + 体格检查各 100 分取平均、任一项 <80 整站不合格。',
                tail,
            ]
                .filter((line) => line !== '')
                .join('\n');
            return {
                ok: written.ok,
                path: written.path ?? '',
                caseNo,
                score: row.score,
                verdict,
                sessions: summary.sessions,
                average: summary.average,
                text,
            };
        },
    });
    return definitions;
}
/** 供 index.ts 复用的病例库预检（安装后自查用）。 */
export async function catalogSize() {
    return (await loadCatalog()).length;
}
