import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tools } from '../../tools/index.ts';
import type { AgentEvent } from '../types.ts';
import { buildSystemPrompt } from './prompt.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具 schema 各不相同，统一用 any 存储
const toolMap = new Map<string, any>(tools.map(t => [t.name, t]));

/** 单次对话最多允许的 LLM 调用轮次，防止工具调用死循环 */
const MAX_ITERATIONS = 10;

/** 执行单个工具调用，失败时返回包含错误描述的 ToolMessage 而非抛出 */
async function executeToolCall(toolCall: {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}) {
  const t = toolMap.get(toolCall.name);

  const toolMessage = t
    ? await t.invoke(toolCall).catch((err: unknown) => {
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

  return { toolCall, toolMessage, result: String(toolMessage.content) };
}

/** 流式输出最终回答，返回完整内容用于追加到历史 */
async function* streamFinalAnswer(
  llm: { stream: (messages: BaseMessage[]) => Promise<AsyncIterable<{ content: unknown }>> },
  messages: BaseMessage[],
): AsyncGenerator<AgentEvent> {
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
}

export const createAgent = (model: string) => {
  const baseURL = process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1';
  const llm = new ChatOpenAI({
    model,
    configuration: { baseURL },
    apiKey: process.env.LLM_API_KEY ?? 'ollama',
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

  /** 获取或创建会话历史 */
  function getOrCreateSession(sessionId: string): BaseMessage[] {
    if (!sessionHistory.has(sessionId)) {
      sessionHistory.set(sessionId, [new SystemMessage(buildSystemPrompt())]);
    }
    return sessionHistory.get(sessionId)!;
  }

  /**
   * 以 ReAct 模式运行 agent，逐步 yield 事件直到模型给出最终回答。
   *
   * 流程：
   *   用户消息 → LLM → 有 tool_calls？
   *     是 → yield tool_call → 执行工具 → yield tool_result → 把结果追加进消息历史 → 再次调用 LLM
   *     否 → yield final → 结束
   */
  async function* run(message: string, sessionId = 'default'): AsyncGenerator<AgentEvent> {
    const messages = getOrCreateSession(sessionId);
    messages.push(new HumanMessage(message));

    let iterations = 0;

    try {
      while (iterations < MAX_ITERATIONS) {
        iterations++;

        const response = await llm.invoke(messages);
        messages.push(response);

        const toolCalls = response.tool_calls ?? [];

        // 没有 tool_calls → 模型已得出最终答案，切换到流式输出
        if (toolCalls.length === 0) {
          // 移除 invoke 的回复，改用 stream 重新生成以获取逐 token 输出
          messages.pop();
          yield* streamFinalAnswer(llm, messages);
          return;
        }

        // 并行执行所有工具调用
        const results = await Promise.all(toolCalls.map(executeToolCall));

        for (const { toolCall, toolMessage, result } of results) {
          yield { type: 'tool_call', name: toolCall.name, args: toolCall.args };
          messages.push(toolMessage);
          yield { type: 'tool_result', name: toolCall.name, result };
        }
      }

      // while 条件退出 = 超出最大轮次
      yield { type: 'error', message: `已达到最大工具调用轮次（${MAX_ITERATIONS}），终止执行` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message: `Agent 执行出错: ${message}` };
    }
  }

  return { run };
};
