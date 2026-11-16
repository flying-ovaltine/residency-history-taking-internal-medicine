/**
 * 住培结业考「病人接诊 · 病史采集」（内科）陪练插件 —— 插件入口。
 *
 * 一个插件干三件事：
 *   1. 注册技能 `history-taking-exam`：SKILL.md 与 32 例病例、4 份手册原样随包分发，
 *      模型的完整 SOP 与素材都在那儿（资源用 resourceBase 指向包内目录）。
 *   2. 注册 5 个工具：osce_start / osce_get_case / osce_rubric / osce_finish / osce_record，
 *      把「抽题 → 当 SP → 切考官 → 打分 → 落盘」变成确定的机制，而不是靠模型记忆。
 *   3. 在**考试进行中**给系统提示补一段角色约束（未开考时返回空串，不污染其他会话）。
 *
 * 运行时零依赖：不 import 任何 @deepseek-ai 包（宿主没把它们装进 profile），
 * 只 import 类型。见 types/dsh.d.ts 的说明。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentFileText, PERSONA_GIST } from './persona.js';
import { skillDir } from './resources.js';
import { getState, stateKey } from './state.js';
import { buildTools, catalogSize } from './tools.js';
export const name = 'residency-history-taking-internal-medicine';
/** 声明的依赖：只声明真正会用到的两个（其余用 ctx.get 可选获取）。 */
export const inject = ['tools', 'skills'];
/** 从 SKILL.md 的 frontmatter 里取单行字段（零依赖）。 */
function frontmatterField(text, key) {
    const head = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^\uFEFF/, ''));
    if (head === null)
        return '';
    const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(head[1] ?? '');
    if (line === null)
        return '';
    return (line[1] ?? '').trim().replace(/^["']|["']$/g, '');
}
/** 去掉 frontmatter，只留正文（技能内容）。 */
function skillBody(text) {
    const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(text.replace(/^\uFEFF/, ''));
    return match === null ? text : text.slice(match[0].length).trimStart();
}
/** 注册技能；任何一步失败只告警，绝不让宿主启动失败。 */
function registerSkill(ctx, warn, skillName) {
    try {
        const path = join(skillDir, 'SKILL.md');
        const raw = readFileSync(path, 'utf8');
        const parsedName = frontmatterField(raw, 'name');
        const description = frontmatterField(raw, 'description');
        const content = skillBody(raw);
        if (description === '' || content === '') {
            warn(`[osce] 技能 ${skillName} 的 frontmatter 不完整，已跳过技能注册`);
            return undefined;
        }
        if (ctx.skills === undefined || typeof ctx.skills.register !== 'function') {
            warn('[osce] 宿主没有 skills 服务，技能未注册（工具仍可用）');
            return undefined;
        }
        return ctx.skills.register({
            name: parsedName === '' ? skillName : parsedName,
            description,
            content,
            resourceBase: { kind: 'directory', path: skillDir },
            source: 'runtime',
        });
    }
    catch (error) {
        warn(`[osce] 技能加载失败：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}
/**
 * 插件主体。
 *
 * @param ctx    cordis Context
 * @param config 可选配置
 */
export function apply(ctx, config = {}) {
    const warn = (message) => {
        ctx.logger?.warn?.(message);
    };
    const disposers = [];
    const skillName = config.skillName ?? 'history-taking-exam';
    const personaEnabled = config.personaPrompt !== false;
    // 1) 技能：SKILL.md + references/ 原样随包分发。
    const skillDisposer = registerSkill(ctx, warn, skillName);
    if (skillDisposer !== undefined)
        disposers.push(skillDisposer);
    // 2) 工具：五个，全部挂在 Host 的 tools 注册表上。
    try {
        const definitions = buildTools(ctx);
        for (const definition of definitions) {
            disposers.push(ctx.tools.register(definition));
        }
    }
    catch (error) {
        warn(`[osce] 工具注册失败：${error instanceof Error ? error.message : String(error)}`);
    }
    // 3) 考试进行中的角色约束：按会话查状态，未开考返回空串。
    if (personaEnabled) {
        ctx.inject?.(['systemPrompt'], (host) => {
            const service = host.get('systemPrompt');
            if (service === undefined || typeof service.context !== 'function')
                return;
            const dispose = service.context({
                name: 'osce-history-taking-persona',
                order: 120,
                text: (assemble) => {
                    const scope = assemble.scope;
                    const id = scope !== null && typeof scope === 'object' ? scope.id : undefined;
                    if (typeof id !== 'string' || id === '')
                        return '';
                    const state = getState(stateKey({ id }));
                    if (state === undefined || state.stage === 'IDLE')
                        return '';
                    return PERSONA_GIST(state.stage, state.caseNo, state.disease, state.department);
                },
            });
            if (typeof dispose === 'function')
                disposers.push(dispose);
        });
    }
    // 4) 资源自检：只在日志里说，不阻塞启动。
    void catalogSize()
        .then((size) => {
        if (size < 29)
            warn(`[osce] 病例库只读到 ${size} 个 case 文件，应为 32 个，请检查 resources/skills/history-taking-exam/references/`);
    })
        .catch(() => {
        warn('[osce] 病例库自检失败，工具仍会按需读取');
    });
    // 5) 卸载时按相反顺序回收。
    ctx.on?.('dispose', () => {
        for (const dispose of disposers.reverse()) {
            try {
                dispose();
            }
            catch {
                // 卸载阶段的异常不再上抛。
            }
        }
    });
}
export { agentFileText };
export { buildTools };
