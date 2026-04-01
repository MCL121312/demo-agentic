import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { createAgent } from '../../agents/index.ts';
import { runWithCwd } from '../../agents/request-context.ts';

/**
 * 按 model 名缓存 agent 实例。
 * 不同 model 对应不同的 LLM 绑定，需要各自的实例。
 */
const agentCache = new Map<string, ReturnType<typeof createAgent>>();

function getAgent(model: string) {
  if (!agentCache.has(model)) {
    agentCache.set(model, createAgent(model));
  }
  return agentCache.get(model)!;
}

const chatRouter = new Hono();

const chatBodySchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional().default('default'),
  model: z.string().optional().default('qwen3.5:4b'),
  /** 客户端工作目录，工具和上下文会基于此路径操作 */
  cwd: z.string().optional(),
});

/** 构造 OpenAI chat.completion.chunk 结构 */
function makeChunk(id: string, model: string, delta: object, finishReason: string | null = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** 将 AgentEvent 转换为一个或多个 SSE 消息，同时输出日志 */
function agentEventToSSE(
  event: import('../../agents/types.ts').AgentEvent,
  id: string,
  model: string,
): Array<{ event?: string; data: string }> {
  switch (event.type) {
    case 'tool_call':
      console.log(`[${id}] tool_call: ${event.name}`, event.args);
      return [
        {
          event: 'tool_call',
          data: JSON.stringify(
            makeChunk(id, model, {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  type: 'function',
                  function: { name: event.name, arguments: JSON.stringify(event.args) },
                },
              ],
            }),
          ),
        },
      ];

    case 'tool_result':
      console.log(`[${id}] tool_result: ${event.name} →`, event.result);
      return [
        {
          event: 'tool_result',
          data: JSON.stringify(makeChunk(id, model, { role: 'tool', content: event.result })),
        },
      ];

    case 'token':
      return [
        {
          data: JSON.stringify(makeChunk(id, model, { role: 'assistant', content: event.content })),
        },
      ];

    case 'final':
      console.log(`[${id}] done`);
      return [{ data: JSON.stringify(makeChunk(id, model, {}, 'stop')) }, { data: '[DONE]' }];

    case 'error':
      console.error(`[${id}] error:`, event.message);
      return [
        {
          event: 'error',
          data: JSON.stringify(
            makeChunk(id, model, { role: 'assistant', content: event.message }, 'stop'),
          ),
        },
        { data: '[DONE]' },
      ];
  }
}

// /chat
chatRouter.post('/', async c => {
  const body = await c.req.json();
  const parsed = chatBodySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const { message, sessionId, model, cwd } = parsed.data;
  const id = `chatcmpl-${Date.now()}`;
  const agent = getAgent(model);

  console.log(`[${id}] session=${sessionId} model=${model}${cwd ? ` cwd=${cwd}` : ''}`);
  console.log(`[${id}] user: ${message}`);

  const effectiveCwd = cwd ?? process.cwd();

  return runWithCwd(effectiveCwd, () =>
    streamSSE(c, async stream => {
      for await (const event of agent.run(message, sessionId)) {
        const sseMessages = agentEventToSSE(event, id, model);
        for (const msg of sseMessages) {
          await stream.writeSSE(msg);
        }
      }
    }),
  );
});

export default chatRouter;
