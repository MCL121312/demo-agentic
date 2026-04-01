export type AgentEvent =
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: string }
  /** 最终回答的单个 token，流式输出时逐个 yield */
  | { type: 'token'; content: string }
  /** 最终回答结束标志 */
  | { type: 'final' }
  | { type: 'error'; message: string };
