import { tools } from '../../tools/index.ts';

/**
 * 根据当前注册的工具列表动态生成系统提示词。
 * 参考 claude-code context.ts 的做法：工具描述直接从工具定义中读取，
 * 避免手动同步工具名称与 prompt 内容。
 */
export function buildSystemPrompt(): string {
  const toolList = tools
    .map(t => `- ${t.name}：${t.description}`)
    .join('\n');

  return `你是一个有用的 AI 助手，可以使用工具来帮助用户解决问题。

## 可用工具
${toolList}

## 行为准则
- 需要获取外部信息时，优先调用合适的工具，而不是凭记忆猜测
- 回答要简洁、准确、友好
- 如果不确定，直接告知用户，不要编造信息`;
}

