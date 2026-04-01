import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { ollamaAgent } from '../../agents/index.ts';

/**
 * 按 model 名缓存 agent 实例。
 * 不同 model 对应不同的 LLM 绑定，需要各自的实例。
 */
const agentCache = new Map<string, ReturnType<typeof ollamaAgent>>();

function getAgent(model: string) {
  if (!agentCache.has(model)) {
    agentCache.set(model, ollamaAgent(model));
  }
  return agentCache.get(model)!;
}

const chatRouter = new Hono();

const chatBodySchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional().default('default'),
  model: z.string().optional().default('qwen3.5:4b'),
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

// /chat
chatRouter.post('/', async c => {
  const body = await c.req.json();
  const parsed = chatBodySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const { message, sessionId, model } = parsed.data;
  const id = `chatcmpl-${Date.now()}`;
  const agent = getAgent(model);

  console.log(`[${id}] session=${sessionId} model=${model}`);
  console.log(`[${id}] user: ${message}`);

  return streamSSE(c, async stream => {
    for await (const event of agent.run(message, sessionId)) {
      if (event.type === 'tool_call') {
        console.log(`[${id}] tool_call: ${event.name}`, event.args);
        // 工具调用：使用自定义 SSE event 名，data 沿用 OpenAI tool_calls delta 格式
        await stream.writeSSE({
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
        });
      } else if (event.type === 'tool_result') {
        console.log(`[${id}] tool_result: ${event.name} →`, event.result);
        // 工具结果：使用自定义 SSE event 名，data 沿用 OpenAI tool role delta 格式
        await stream.writeSSE({
          event: 'tool_result',
          data: JSON.stringify(makeChunk(id, model, { role: 'tool', content: event.result })),
        });
      } else if (event.type === 'token') {
        // 逐 token 流式输出：标准 OpenAI content delta
        await stream.writeSSE({
          data: JSON.stringify(makeChunk(id, model, { role: 'assistant', content: event.content })),
        });
      } else if (event.type === 'final') {
        console.log(`[${id}] done`);
        // 流式输出结束标志：发送 finish_reason 和 [DONE]
        await stream.writeSSE({
          data: JSON.stringify(makeChunk(id, model, {}, 'stop')),
        });
        await stream.writeSSE({ data: '[DONE]' });
      } else if (event.type === 'error') {
        console.error(`[${id}] error:`, event.message);
        // 错误事件：发送后结束流
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify(
            makeChunk(id, model, { role: 'assistant', content: event.message }, 'stop'),
          ),
        });
        await stream.writeSSE({ data: '[DONE]' });
      }
    }
  });
});

export default chatRouter;
