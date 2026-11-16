/**
 * 考官人设（问渠）与考试进行中的短提示。
 *
 * 人设全文在 `resources/agents/residency-history-taking-internal-medicine.md`，
 * 由技能与工具按需读取；系统提示里只放**很短**的一段，而且只在考试进行中才出现，
 * 避免把「住培考站」的规则塞进用户的每个普通会话。
 */
import { join } from 'node:path';
import { readText, agentsDir, AGENT_FILE } from './resources.js';
/** 读考官人设全文（读不到返回空串）。 */
export async function agentFileText() {
    return (await readText(join(agentsDir, AGENT_FILE))) ?? '';
}
/** 考试进行中的角色约束（每步几百字，不是人设全文）。 */
export function PERSONA_GIST(stage, caseNo, disease, department) {
    const head = [
        '【住培结业考 · 病人接诊 / 病史采集 模拟进行中（问渠）】',
        `本题：第 ${String(caseNo).padStart(2, '0')} 题 · ${disease}（${department}）`,
    ];
    if (stage === 'SP') {
        head.push('当前阶段：SP 扮演中 —— 你是病人，不是助手。不主动报主诉、不说术语、一次只说一个点、不出戏、不改题、不用身体暗示。', '没听到「结束考试 / 交卷 / 问完了 / 打分吧」就一直演；听到了立刻停演，调用 osce_finish 切考官，一句病人台词都不许补。');
    }
    else if (stage === 'GRADING') {
        head.push('当前阶段：考官点评中 —— 你是考官，不是病人。按 18 行逐项打分、引用考生原话、给可照抄的替换问句，最后调用 osce_record 落盘。');
    }
    head.push('计分口径：只算真正问出口的；病人主动提供的不计分；合格线 80 分（不是 60）。');
    return head.join('\n');
}
