/**
 * The L1 context block injected into every system prompt of a session whose
 * project is active. Faithful port of GenericAgent's `_build_injection`:
 * rules + memory pointer (L1) stay in-prompt; the memory file itself (L2) is
 * deliberately NOT injected — the model reads it on demand with file tools.
 * @module dsh-project-mode/src/l1
 */

import type { L1Material } from './store.ts';
/** Projects-root-independent prefix used verbatim by the L1 provider. */
const L1_HEAD = (name: string): string => `[PROJECT MODE: ${name}]`;
/**
 * Build the L1 block for one project.
 * @param material - synchronous project material (see {@link ProjectStore.l1MaterialSync}).
 * @returns the block, or '' for an empty material (defensive; the provider
 * checks per-project existence itself and never calls with one).
 */
export function buildL1Block(material: L1Material): string {
    const { name, dir, memoryPath, memory, instruction, assets, skills, datasources, experts } = material;
    const memHint = memory.exists && memory.bytes > 0
        ? `项目全量记忆在 ${memoryPath}（${memory.lines} 行 / ${memory.bytes} 字节）。`
            + '本轮任务若涉及项目上下文（接续工作、查约定、避坑），先读它再动手；若与项目认知无关（闲聊、独立小事），可不读。自行判断。'
        : `项目记忆 ${memoryPath} 暂为空（本项目尚无沉淀），无需读取。`;
    const lines = [
        '',
        '---',
        L1_HEAD(name),
        `你正在「${name}」项目模式中（本会话已激活）。`,
        '',
        '## 规则',
        `- 项目产物、文档、草稿一律放项目目录：${dir}（相对路径以它为根，勿写进 harness 数据目录）`,
        `- ${memHint}`,
    ];
    if (instruction.length > 0) {
        lines.push('', '## 项目指令（用户设定，请严格遵守）', instruction);
    }
    if (assets.length > 0) {
        lines.push('', '## 项目资产引用（本地目录）');
        for (const ref of assets) {
            lines.push(ref.readonly
                ? `- [只读] ${ref.name}：${ref.path}（仅作上下文，请勿改动）`
                : `- [可写] ${ref.name}：${ref.path}（项目活代码，可直接修改）`);
        }
    }
    const gaParts: string[] = [];
    const skillList = skills ?? [];
    const dsList = datasources ?? [];
    const expertList = experts ?? [];
    if (skillList.length > 0)
        gaParts.push(`技能：${skillList.join('、')}`);
    if (dsList.length > 0)
        gaParts.push(`数据源：${dsList.join('、')}`);
    if (expertList.length > 0)
        gaParts.push(`专家：${expertList.join('、')}`);
    if (gaParts.length > 0) {
        lines.push('', '## 项目能力（自 GenericAgent 导入）', ...gaParts);
    }
    lines.push('', '## 收尾纪律', `干完本轮活后自问：「记忆归零、重新接手本项目的我，缺了本轮哪条信息会重复付出认知代价——`
        + `再踩一次坑、再摸索一次、再问一次用户？」会的，就用文件工具把那条追加进 ${memoryPath}，`
        + '写成未来的自己能直接复用的一句话（一条一句，已有条目增量更新）；不会的，一个字都不写。', '---');
    return lines.join('\n') + '\n';
}
