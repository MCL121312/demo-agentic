import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const getCurrentTime = tool(async () => new Date().toLocaleString('zh-CN'), {
  name: 'get_current_time',
  description: '获取当前的日期和时间',
  schema: z.object({}),
});

