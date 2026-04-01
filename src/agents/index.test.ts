import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent } from './index.ts';

// vi.hoisted 保证变量在 vi.mock 工厂函数执行前就已初始化
const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock('@langchain/ollama', () => ({
  ChatOllama: vi.fn().mockImplementation(function () {
    return { bindTools: vi.fn().mockReturnValue({ invoke: mockInvoke }) };
  }),
}));

// mock 必须在最顶层声明，import 写在 mock 之后
const { ollamaAgent } = await import('./index.ts');

describe('ollamaAgent', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('无需工具时直接 yield final 事件', async () => {
    mockInvoke.mockResolvedValueOnce({
      tool_calls: [],
      content: '你好！',
    });

    const agent = ollamaAgent();
    const events: AgentEvent[] = [];
    for await (const event of agent.run('你好')) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'final', content: '你好！' });
  });

  it('调用工具后 yield tool_call → tool_result → final', async () => {
    // 第一次 invoke：模型决定调用工具
    mockInvoke.mockResolvedValueOnce({
      tool_calls: [{ name: 'get_current_time', args: {}, id: 'call_1' }],
      content: '',
    });
    // 第二次 invoke：模型收到工具结果后给出最终回答
    mockInvoke.mockResolvedValueOnce({
      tool_calls: [],
      content: '现在是下午3点',
    });

    const agent = ollamaAgent();
    const events: AgentEvent[] = [];
    for await (const event of agent.run('现在几点了？')) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: 'tool_call', name: 'get_current_time' });
    expect(events[1]).toMatchObject({ type: 'tool_result', name: 'get_current_time' });
    expect(events[2]).toEqual({ type: 'final', content: '现在是下午3点' });
  });

  it('遇到未知工具时 result 包含错误提示', async () => {
    mockInvoke.mockResolvedValueOnce({
      tool_calls: [{ name: 'unknown_tool', args: {}, id: 'call_2' }],
      content: '',
    });
    mockInvoke.mockResolvedValueOnce({ tool_calls: [], content: '好的' });

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
});
