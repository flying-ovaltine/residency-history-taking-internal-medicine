/** 插件内部用到的少量结构类型（不引入任何运行时依赖）。 */

/** Agent 的最小形状：只需要会话 id。 */
export interface Agent {
  readonly id: string
}

/** 工具执行上下文里我们关心的部分。 */
export interface ToolRunContextLike {
  readonly agent?: Agent
  readonly signal?: AbortSignal
}
