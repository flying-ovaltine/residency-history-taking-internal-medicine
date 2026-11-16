/**
 * 资源定位与文本读取。
 *
 * 所有中文素材（32 例病例脚本、4 份手册、考官人设、头像）都原样放在包内
 * `resources/` 下。这里按**模块自身位置**解析路径：`src/` 与编译产物 `lib/`
 * 都在包根下一层，所以 `new URL('..', import.meta.url)` 对两者都成立。
 * 绝不写死 `C:\Users\...` 之类本机路径，整个插件目录可以整体搬家。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** 包根目录（含 package.json、resources/、lib/ 的那一层）。 */
export const packageRoot = fileURLToPath(new URL('..', import.meta.url));
/** 素材根目录。 */
export const resourcesDir = join(packageRoot, 'resources');
/** 技能目录（SKILL.md + references/），与源素材一一对应。 */
export const skillDir = join(resourcesDir, 'skills', 'history-taking-exam');
/** 病例与手册目录。 */
export const referencesDir = join(skillDir, 'references');
/** 考官人设目录。 */
export const agentsDir = join(resourcesDir, 'agents');
/** 头像目录。 */
export const avatarsDir = join(resourcesDir, 'avatars');
/** 考官人设文件名（问渠）。 */
export const AGENT_FILE = 'residency-history-taking-internal-medicine.md';
/** 手册文件名常量。 */
export const HANDBOOKS = {
    rubric: '评分表.md',
    sp: 'SP扮演手册.md',
    examiner: '考官评分手册.md',
    cheatSheet: '速查卡.md',
};
/** 读一个 UTF-8 文本文件；读不到返回 undefined（调用方决定降级方式）。 */
export async function readText(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch {
        return undefined;
    }
}
/** 判断路径是否存在。 */
export async function exists(path) {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}
/** 列出病例文件名（不含内容），读不到目录时返回空数组。 */
export async function listCaseFileNames() {
    try {
        const entries = await readdir(referencesDir, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isFile() && /^case-\d{2}-.+\.md$/i.test(entry.name))
            .map((entry) => entry.name)
            .sort();
    }
    catch {
        return [];
    }
}
