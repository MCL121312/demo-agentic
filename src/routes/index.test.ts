import { describe, expect, it } from 'vitest';
import app from './index.ts';

describe('根路由', () => {
  it('根路由应该列出路由', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
  });
});

describe('对话', () => {
  it('正常对话', async () => {
    // 用户应该可以通过 /chat路由开启一个对话
    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好' }),
    });

    expect(res.status).toBe(200);
  });
});
