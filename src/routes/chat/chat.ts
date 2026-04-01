import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { ollamaAgent } from '../../agents/index.ts';

const agent = ollamaAgent();

const chatRouter = new Hono();

const chatBodySchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional().default('default'),
  model: z.string().optional().default('qwen3.5:2b'),
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

  const { message, model } = parsed.data;
  const id = `chatcmpl-${Date.now()}`;

  return streamSSE(c, async stream => {
    for await (const event of agent.run(message)) {
      if (event.type === 'tool_call') {
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
        // 工具结果：使用自定义 SSE event 名，data 沿用 OpenAI tool role delta 格式
        await stream.writeSSE({
          event: 'tool_result',
          data: JSON.stringify(makeChunk(id, model, { role: 'tool', content: event.result })),
        });
      } else if (event.type === 'final') {
        // 最终回答：标准 OpenAI content delta，随后发 finish_reason 和 [DONE]
        await stream.writeSSE({
          data: JSON.stringify(makeChunk(id, model, { role: 'assistant', content: event.content })),
        });
        await stream.writeSSE({
          data: JSON.stringify(makeChunk(id, model, {}, 'stop')),
        });
        await stream.writeSSE({ data: '[DONE]' });
      }
    }
  });
});

export default chatRouter;
