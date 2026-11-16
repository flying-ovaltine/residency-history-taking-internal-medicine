/**
 * 考试状态机（按会话隔离）。
 *
 *   IDLE（未开考） → SP（扮演中） → GRADING（考官点评） → IDLE
 *
 * 工具是全局注册的，所以状态必须挂在**会话**上：同一台机器上开两个会话，
 * 各考各的，互不串场。状态只在内存里，进程重启就清零 —— 这是刻意的：
 * 半场考试的状态比没有状态更容易误导人。
 */
const states = new Map();
/** 状态键：优先会话 id；取不到就退到进程级单槽（不串场是加分项，不是前置条件）。 */
export function stateKey(agent) {
    const id = agent?.id;
    return typeof id === 'string' && id !== '' ? id : '__global__';
}
/** 读状态。 */
export function getState(key) {
    return states.get(key);
}
/** 写状态（覆盖）。 */
export function setState(key, state) {
    states.set(key, state);
    return state;
}
/** 清状态。 */
export function clearState(key) {
    states.delete(key);
}
/** 开考：把状态重置成一堂新考试。 */
export function beginExam(key, init) {
    const state = {
        stage: 'SP',
        mode: init.mode,
        caseNo: init.caseNo,
        disease: init.disease,
        department: init.department,
        extra: init.extra,
        startedAt: Date.now(),
        startSeq: init.startSeq,
        helpCount: 0,
    };
    states.set(key, state);
    return state;
}
/** 截止交卷：保留 pending 供写记录，阶段推到 GRADING。 */
export function markGrading(key, elapsedMinutes) {
    const state = states.get(key);
    if (state === undefined)
        return undefined;
    state.stage = 'GRADING';
    state.pending = {
        caseNo: state.caseNo,
        disease: state.disease,
        department: state.department,
        elapsedMinutes,
        endedAt: Date.now(),
    };
    return state;
}
/** 记录写完：回到 IDLE。 */
export function markIdle(key) {
    const state = states.get(key);
    if (state === undefined)
        return;
    state.stage = 'IDLE';
    state.pending = undefined;
}
/** 当前阶段的中文名。 */
export function stageLabel(stage) {
    if (stage === 'SP')
        return 'SP 扮演中';
    if (stage === 'GRADING')
        return '考官点评中';
    return '未开考';
}
