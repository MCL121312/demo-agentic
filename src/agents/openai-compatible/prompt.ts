import { tools } from '../../tools/index.ts';
import { buildContext } from '../context.ts';

/**
 * 根据当前注册的工具列表 + 动态上下文生成系统提示词。
 *
 * 参考 claude-code context.ts 的做法：
 * 1. 工具描述直接从工具定义中读取，避免手动同步
 * 2. 动态注入 cwd、git 状态、项目结构等上下文
 */
export function buildSystemPrompt(): string {
  const toolList = tools.map(t => `- ${t.name}：${t.description}`).join('\n');

  const context = buildContext();

  return `你是一个智能编程助手，可以使用工具来帮助用户完成编程任务。

## 当前环境
${context}

## 可用工具
${toolList}

## 行为准则
- 操作文件前，先用 file_list 和 file_read 了解项目结构和现有代码
- 需要获取外部信息时，优先调用合适的工具，而不是凭记忆猜测
- 修改代码前先理解上下文，避免破坏现有功能
- 回答要简洁、准确、友好
- 如果不确定，直接告知用户，不要编造信息`;
}
