/**
 * 训练记录：只追加的 Markdown 表格，落在用户主目录下。
 *
 * 位置：`~/.workbuddy/history-taking-records.md`
 *   → 目录建不了 / 写不进去：退到会话工作目录的 `训练记录.md`
 *   → 还写不进去：静默降级，不报错、不中断考试，也不声称「已记录」
 *
 * 只追加、不改写旧行：一旦重排历史，累计就不可信了。统计一律在读的时候现算。
 */
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** 记录表头（文件不存在时先写这行）。 */
const HEADER = [
    '# 病史采集训练记录',
    '',
    '| 日期时间 | 题号 | 病种 | 总分 | 判定 | 主要失分项 | 用时 | 求助 |',
    '|---|---|---|---|---|---|---|---|',
    '',
].join('\n');
/** 记录文件路径候选，按优先级排列。 */
export function recordsPathCandidates(fallbackDir) {
    const paths = [join(homedir(), '.workbuddy', 'history-taking-records.md')];
    if (fallbackDir !== undefined && fallbackDir !== '') {
        paths.push(join(fallbackDir, '训练记录.md'));
    }
    return paths;
}
/** 两位补零。 */
function pad(value) {
    return String(value).padStart(2, '0');
}
/** 本地时间戳，格式 YYYY-MM-DD HH:mm。 */
export function timestamp(date = new Date()) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** 从表格行里拆出单元格。 */
function cellsOf(line) {
    return line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim());
}
/** 解析记录文件里的全部战绩行（跳过表头与分隔行）。 */
export function parseRecords(text) {
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trimStart().startsWith('|'))
            continue;
        const cells = cellsOf(line);
        if (cells.length < 4)
            continue;
        if (/^-{2,}$/.test(cells[0] ?? '') || cells[0] === '日期时间')
            continue;
        const caseNo = Number.parseInt(cells[1] ?? '', 10);
        const score = Number.parseFloat(cells[3] ?? '');
        if (!Number.isFinite(caseNo) || !Number.isFinite(score))
            continue;
        rows.push({
            at: cells[0] ?? '',
            caseNo,
            disease: cells[2] ?? '',
            score,
            verdict: cells[4] ?? '',
            lost: cells[5] ?? '',
            minutes: Number.parseInt(cells[6] ?? '', 10) || 0,
            help: Number.parseInt(cells[7] ?? '', 10) || 0,
        });
    }
    return rows;
}
/** 现算统计：场次、均分、已练题号、失分项计数、老毛病。 */
export function summarize(rows) {
    const practiced = [...new Set(rows.map((row) => row.caseNo))].sort((a, b) => a - b);
    const total = rows.reduce((sum, row) => sum + row.score, 0);
    const lostCounts = {};
    for (const row of rows) {
        for (const item of row.lost.split(/[、，,;；]/)) {
            const key = item.trim();
            if (key === '')
                continue;
            lostCounts[key] = (lostCounts[key] ?? 0) + 1;
        }
    }
    const oldHabits = Object.entries(lostCounts)
        .filter(([, count]) => count >= 3)
        .sort((a, b) => b[1] - a[1])
        .map(([item]) => item);
    return {
        sessions: rows.length,
        average: rows.length === 0 ? 0 : Math.round((total / rows.length) * 10) / 10,
        practiced,
        lostCounts,
        oldHabits,
    };
}
/** 读记录：返回第一条可读文件的战绩与路径。 */
export async function readRecords(fallbackDir) {
    for (const path of recordsPathCandidates(fallbackDir)) {
        try {
            const text = await readFile(path, 'utf8');
            const rows = parseRecords(text);
            return { rows, path, summary: summarize(rows) };
        }
        catch {
            // 读不到就当这份不存在，继续看下一个候选。
        }
    }
    return { rows: [], summary: summarize([]) };
}
/** 追加一行战绩：哪个候选能写就写哪个，全都不行则静默降级。 */
export async function appendRecord(row, fallbackDir) {
    const line = `| ${row.at} | ${String(row.caseNo).padStart(2, '0')} | ${row.disease} | ${row.score} | ${row.verdict} | ${row.lost} | ${row.minutes} min | ${row.help} |\n`;
    const reasons = [];
    for (const path of recordsPathCandidates(fallbackDir)) {
        try {
            await mkdir(dirname(path), { recursive: true });
            let needsHeader = true;
            try {
                const info = await stat(path);
                needsHeader = info.size === 0;
            }
            catch {
                needsHeader = true;
            }
            await appendFile(path, needsHeader ? HEADER + line : line, 'utf8');
            return { ok: true, path };
        }
        catch (error) {
            reasons.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { ok: false, reason: reasons.join(' | ') };
}
