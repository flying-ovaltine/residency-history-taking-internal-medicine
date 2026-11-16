/**
 * 本机 DSH 宿主把 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools` 一起打在 asar 里，
 * **不**安装到 profile 的 node_modules，所以插件在运行时 import 这两个包会解析失败。
 *
 * 处理办法：这里给出它们的最小环境声明，源码里只写 `import type`（编译后不留任何
 * import），运行时用 `ctx.tools.register(<ToolDefinition 同结构对象>)` 注册。
 * 这样既有类型约束，又不会因为找不到包而把宿主启动弄崩。
 */

declare module '@deepseek-ai/dsh-tools' {
  /** 工具返回给模型的内容块（这里只用到纯文本）。 */
  export interface ContentBlock {
    type: 'text'
    text: string
  }

  /** 工具输出声明。 */
  export interface ToolOutputDefinition {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): ContentBlock[]
  }

  /** 工具定义，与宿主 `ToolDefinition` 结构一致。 */
  export interface ToolDefinition {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: ToolOutputDefinition
    execute(args: any, exec: any): Promise<unknown>
  }
}

declare module '@deepseek-ai/cordis' {
  import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

  /** 技能注册入参（与 `SkillRegistration` 一致的部分）。 */
  export interface SkillRegistrationLike {
    name: string
    description: string
    content: string
    whenToUse?: string
    resourceBase?: { kind: 'directory'; path: string } | { kind: 'url'; url: string } | { kind: 'opaque'; description: string }
    source?: string
  }

  /** 提示词段落（与 `PromptContext` 一致的部分）。 */
  export interface PromptContextLike {
    name: string
    order: number
    text: string | ((context: { scope?: unknown }) => string)
    interpolate?: boolean
  }

  /** 插件拿得到的 Context 子集。 */
  export interface Context {
    tools: {
      register(definition: ToolDefinition): () => void
    }
    skills?: {
      register(skill: SkillRegistrationLike): () => void
    }
    get(name: string): any
    inject?(names: string[], callback: (scoped: Context) => void): unknown
    on?(event: 'dispose', listener: () => void): unknown
    effect?(fn: () => (() => void) | void): unknown
    logger?: {
      warn?(message: string): void
      info?(message: string): void
    }
  }
}
