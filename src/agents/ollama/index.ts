import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tools } from '../../tools/index.ts';
import type { AgentEvent } from '../types.ts';
import { buildSystemPrompt } from './prompt.ts';

const toolMap = new Map<string, (typeof tools)[number]>(tools.map(t => [t.name, t]));

/** 单次对话最多允许的 LLM 调用轮次，防止工具调用死循环 */
const MAX_ITERATIONS = 10;

export const ollamaAgent = (model: string) => {
  const baseURL = `${process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'}/v1`;
  const llm = new ChatOpenAI({
    model,
    configuration: { baseURL },
    apiKey: 'ollama',
    temperature: 0.2,
    maxRetries: 2,
  }).bindTools(tools);

  /**
   * 多轮对话历史缓存：key 为 sessionId，value 为该会话的消息列表。
   * SystemMessage 只在第一轮注入，后续轮次直接追加用户消息。
   *
   * NOTE 仅内存存储：服务重启后所有会话历史会丢失。
   * 如需持久化，可将此 Map 替换为 Redis 或数据库查询。
   */
  const sessionHistory = new Map<string, BaseMessage[]>();

  /**
   * 以 ReAct 模式运行 agent，逐步 yield 事件直到模型给出最终回答。
   *
   * 流程：
   *   用户消息 → LLM → 有 tool_calls？
   *     是 → yield tool_call → 执行工具 → yield tool_result → 把结果追加进消息历史 → 再次调用 LLM
   *     否 → yield final → 结束
   *
   * @param message   用户输入的文本
   * @param sessionId 会话 ID，相同 ID 的请求共享消息历史，实现多轮对话
   * @yields tool_call   模型决定调用某个工具时发出，包含工具名和参数
   * @yields tool_result 工具执行完毕时发出，包含返回结果
   * @yields final       模型不再调用工具、输出最终回答时发出
   * @yields error       发生不可恢复错误时发出
   */
  async function* run(message: string, sessionId = 'default'): AsyncGenerator<AgentEvent> {
    // 首次访问该 session 时初始化历史，注入 SystemMessage
    if (!sessionHistory.has(sessionId)) {
      sessionHistory.set(sessionId, [new SystemMessage(buildSystemPrompt())]);
    }
    const messages = sessionHistory.get(sessionId)!;
    // 追加本轮用户消息
    messages.push(new HumanMessage(message));

    let iterations = 0;

    try {
      while (true) {
        // 超出最大轮次，终止循环并通知客户端
        if (iterations >= MAX_ITERATIONS) {
          yield { type: 'error', message: `已达到最大工具调用轮次（${MAX_ITERATIONS}），终止执行` };
          return;
        }
        iterations++;

        // 先用 invoke 判断是否有 tool_calls（stream 不支持直接读 tool_calls）
        const response = await llm.invoke(messages);
        messages.push(response);

        const toolCalls = response.tool_calls ?? [];

        // 没有 tool_calls，说明模型已得出最终答案，切换到流式输出
        if (toolCalls.length === 0) {
          // 移除刚刚 invoke 追加的回复，改用 stream 重新生成以获取逐 token 输出
          messages.pop();
          let fullContent = '';
          const stream = await llm.stream(messages);
          for await (const chunk of stream) {
            const token = String(chunk.content);
            if (token) {
              fullContent += token;
              yield { type: 'token', content: token };
            }
          }
          // 把完整回答追加进历史，保持多轮对话上下文正确
          messages.push(new AIMessage(fullContent));
          yield { type: 'final' };
          return;
        }

        // 并行执行所有工具调用（一次 LLM 响应可能包含多个）
        const toolResults = await Promise.all(
          toolCalls.map(async toolCall => {
            const t = toolMap.get(toolCall.name);
            // 工具不存在时返回错误描述，让模型自行处理
            const toolMessage = t
              ? await t.invoke(toolCall).catch((err: unknown) => {
                  // 工具执行失败时构造错误 ToolMessage，而非抛出
                  const msg = err instanceof Error ? err.message : String(err);
                  return new ToolMessage({
                    content: `工具 ${toolCall.name} 执行失败: ${msg}`,
                    tool_call_id: toolCall.id ?? toolCall.name,
                  });
                })
              : new ToolMessage({
                  content: `未知工具: ${toolCall.name}`,
                  tool_call_id: toolCall.id ?? toolCall.name,
                });

            // invoke(ToolCall) 直接返回 ToolMessage，content 才是真正的工具执行结果
            return { toolCall, toolMessage, result: String(toolMessage.content) };
          }),
        );

        for (const { toolCall, toolMessage, result } of toolResults) {
          yield { type: 'tool_call', name: toolCall.name, args: toolCall.args };
          // 将工具结果以 ToolMessage 追加到历史，模型下一轮可以读取
          messages.push(toolMessage);
          yield { type: 'tool_result', name: toolCall.name, result };
        }
      }
    } catch (err) {
      // LLM 调用本身失败（网络错误、模型不存在等）
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message: `Agent 执行出错: ${message}` };
    }
  }

  return { run };
};
