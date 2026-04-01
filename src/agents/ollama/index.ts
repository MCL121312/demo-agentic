import { ChatOllama } from '@langchain/ollama';
import { HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tools } from '../../tools/index.ts';
import type { AgentEvent } from '../types.ts';
import { buildSystemPrompt } from './prompt.ts';

const toolMap = new Map<string, (typeof tools)[number]>(tools.map(t => [t.name, t]));

/** 单次对话最多允许的 LLM 调用轮次，防止工具调用死循环 */
const MAX_ITERATIONS = 10;

export const ollamaAgent = (model = 'qwen3.5:2b') => {
  const llm = new ChatOllama({
    model,
    temperature: 0.2,
    maxRetries: 2,
  }).bindTools(tools);

  /**
   * 以 ReAct 模式运行 agent，逐步 yield 事件直到模型给出最终回答。
   *
   * 流程：
   *   用户消息 → LLM → 有 tool_calls？
   *     是 → yield tool_call → 执行工具 → yield tool_result → 把结果追加进消息历史 → 再次调用 LLM
   *     否 → yield final → 结束
   *
   * @param message 用户输入的文本
   * @yields tool_call   模型决定调用某个工具时发出，包含工具名和参数
   * @yields tool_result 工具执行完毕时发出，包含返回结果
   * @yields final       模型不再调用工具、输出最终回答时发出
   */
  async function* run(message: string): AsyncGenerator<AgentEvent> {
    const messages: BaseMessage[] = [
      new SystemMessage(buildSystemPrompt()),
      new HumanMessage(message),
    ];

    while (true) {
      const response = await llm.invoke(messages);
      // 将模型回复追加到历史，供下一轮携带上下文
      messages.push(response);

      const toolCalls = response.tool_calls ?? [];

      // 没有 tool_calls，说明模型已得出最终答案
      if (toolCalls.length === 0) {
        yield { type: 'final', content: String(response.content) };
        return;
      }

      // 依次执行所有工具调用（一次 LLM 响应可能包含多个）
      for (const toolCall of toolCalls) {
        yield { type: 'tool_call', name: toolCall.name, args: toolCall.args };

        const t = toolMap.get(toolCall.name);
        // 工具不存在时返回错误描述，让模型自行处理
        const toolMessage = t
          ? await t.invoke(toolCall)
          : new ToolMessage({
              content: `未知工具: ${toolCall.name}`,
              tool_call_id: toolCall.id ?? toolCall.name,
            });

        // invoke(ToolCall) 直接返回 ToolMessage，content 才是真正的工具执行结果
        const result = String(toolMessage.content);

        // 将工具结果以 ToolMessage 追加到历史，模型下一轮可以读取
        messages.push(toolMessage);
        yield { type: 'tool_result', name: toolCall.name, result };
      }
    }
  }

  return { run };
};
