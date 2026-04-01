import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent } from './index.ts';

// vi.hoisted 保证变量在 vi.mock 工厂函数执行前就已初始化
const mockInvoke = vi.hoisted(() => vi.fn());

// mockStream 模拟 llm.stream() 返回逐 token 的异步迭代器
const mockStream = vi.hoisted(() => vi.fn());

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(function () {
    return {
      bindTools: vi.fn().mockReturnValue({
        invoke: mockInvoke,
        stream: mockStream,
      }),
    };
  }),
}));

// mock 必须在最顶层声明，import 写在 mock 之后
const { ollamaAgent } = await import('./index.ts');

describe('ollamaAgent', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockStream.mockReset();
  });

  it('无需工具时逐 token yield，最后 yield final', async () => {
    // invoke 返回无 tool_calls，触发流式输出
    mockInvoke.mockResolvedValueOnce({ tool_calls: [], content: '' });
    // stream 返回两个 token chunk
    mockStream.mockResolvedValueOnce(
      (async function* () {
        yield { content: '你好' };
        yield { content: '！' };
      })(),
    );

    const agent = ollamaAgent();
    const events: AgentEvent[] = [];
    for await (const event of agent.run('你好')) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: 'token', content: '你好' });
    expect(events[1]).toEqual({ type: 'token', content: '！' });
    expect(events[2]).toEqual({ type: 'final' });
  });

  it('调用工具后 yield tool_call → tool_result → token → final', async () => {
    // 第一次 invoke：模型决定调用工具
    mockInvoke.mockResolvedValueOnce({
      tool_calls: [{ name: 'get_current_time', args: {}, id: 'call_1' }],
      content: '',
    });
    // 第二次 invoke：模型收到工具结果后，无 tool_calls，触发流式
    mockInvoke.mockResolvedValueOnce({ tool_calls: [], content: '' });
    // stream 返回最终回答
    mockStream.mockResolvedValueOnce(
      (async function* () {
        yield { content: '现在是下午3点' };
      })(),
    );

    const agent = ollamaAgent();
    const events: AgentEvent[] = [];
    for await (const event of agent.run('现在几点了？')) {
      events.push(event);
    }

    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ type: 'tool_call', name: 'get_current_time' });
    expect(events[1]).toMatchObject({ type: 'tool_result', name: 'get_current_time' });
    expect(events[2]).toEqual({ type: 'token', content: '现在是下午3点' });
    expect(events[3]).toEqual({ type: 'final' });
  });

  it('遇到未知工具时 result 包含错误提示', async () => {
    mockInvoke.mockResolvedValueOnce({
      tool_calls: [{ name: 'unknown_tool', args: {}, id: 'call_2' }],
      content: '',
    });
    mockInvoke.mockResolvedValueOnce({ tool_calls: [], content: '好的' });
    mockStream.mockResolvedValueOnce(
      (async function* () {
        yield { content: '好的' };
      })(),
    );

    const agent = ollamaAgent();
    const events: AgentEvent[] = [];
    for await (const event of agent.run('触发未知工具')) {
      events.push(event);
    }

    const toolResult = events.find(e => e.type === 'tool_result') as Extract<
      AgentEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult.result).toContain('未知工具');
  });

  describe('多轮对话与 session 隔离', () => {
    /** 辅助：跑完一轮对话，丢弃事件，只关心副作用（消息历史） */
    async function runOnce(
      agent: ReturnType<typeof ollamaAgent>,
      message: string,
      sessionId: string,
      reply: string,
    ) {
      mockInvoke.mockResolvedValueOnce({ tool_calls: [], content: '' });
      mockStream.mockResolvedValueOnce(
        (async function* () {
          yield { content: reply };
        })(),
      );
      for await (const _ of agent.run(message, sessionId)) {
        /* 消费完生成器 */
      }
    }

    it('同一 sessionId 的第二轮 invoke 携带第一轮的完整历史', async () => {
      const agent = ollamaAgent();

      // 第一轮：告知名字
      await runOnce(agent, '我叫张三', 'user_001', '你好，张三！');

      // 第二轮：询问名字
      await runOnce(agent, '我叫什么名字？', 'user_001', '你叫张三。');

      // mock 记录的是数组引用，断言时数组已追加第二轮 AI 回复，共 5 条：
      // [System, Human1('我叫张三'), AI1('你好，张三！'), Human2('我叫什么名字？'), AI2('你叫张三。')]
      const secondCallMessages = mockInvoke.mock.calls[1][0] as { content: string }[];
      expect(secondCallMessages).toHaveLength(5);
      // 验证第一轮的人类消息和 AI 回复都在历史中
      expect(secondCallMessages[1].content).toBe('我叫张三');
      expect(secondCallMessages[2].content).toBe('你好，张三！');
      expect(secondCallMessages[3].content).toBe('我叫什么名字？');
    });

    it('不同 sessionId 的历史互不影响', async () => {
      const agent = ollamaAgent();

      // session A 先跑一轮
      await runOnce(agent, 'A 的消息', 'session_a', '收到 A');

      // session B 第一次发消息，不应看到 A 的历史
      await runOnce(agent, 'B 的消息', 'session_b', '收到 B');

      // mock 记录引用，断言时 session B 的数组已追加 AI 回复，共 3 条：
      // [System, Human('B 的消息'), AI('收到 B')]
      const sessionBMessages = mockInvoke.mock.calls[1][0] as { content: string }[];
      expect(sessionBMessages).toHaveLength(3);
      expect(sessionBMessages[1].content).toBe('B 的消息');
      // session A 的消息不在 session B 的历史中
      expect(sessionBMessages.some(m => m.content === 'A 的消息')).toBe(false);
    });

    it('新 agent 实例（模拟服务重启）不保留任何 session 历史', async () => {
      // 第一个实例跑一轮，建立历史
      const agent1 = ollamaAgent();
      await runOnce(agent1, '我叫张三', 'user_001', '你好，张三！');

      // 重置 mock 调用记录，模拟新进程启动
      mockInvoke.mockReset();
      mockStream.mockReset();

      // 新实例使用相同 sessionId，历史应已清空
      const agent2 = ollamaAgent();
      await runOnce(agent2, '我叫什么名字？', 'user_001', '你好，请问你是谁？');

      // mock 记录引用，断言时数组已追加 AI 回复，共 3 条：
      // [System, Human('我叫什么名字？'), AI('你好，请问你是谁？')]
      const messages = mockInvoke.mock.calls[0][0] as { content: string }[];
      expect(messages).toHaveLength(3);
      expect(messages[1].content).toBe('我叫什么名字？');
      // 第一个实例的历史（'我叫张三'）不存在于新实例中
      expect(messages.some(m => m.content === '我叫张三')).toBe(false);
    });
  });
});
