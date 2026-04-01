import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolvePath } from '../agents/request-context.ts';

export const fileRead = tool(
  async ({ path, startLine, endLine }) => {
    try {
      const absPath = resolvePath(path);
      const content = await readFile(absPath, 'utf-8');
      const lines = content.split('\n');

      const start = Math.max(1, startLine ?? 1);
      const end = Math.min(lines.length, endLine ?? lines.length);
      const selected = lines.slice(start - 1, end);

      // 带行号输出，方便 agent 后续精准编辑
      const numbered = selected.map((line, i) => `${start + i}: ${line}`).join('\n');

      return `文件: ${absPath} (共 ${lines.length} 行，显示 ${start}-${end})\n\n${numbered}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `读取文件失败: ${msg}`;
    }
  },
  {
    name: 'file_read',
    description: '读取指定文件的内容。可通过 startLine/endLine 只读取部分行。返回带行号的内容。',
    schema: z.object({
      path: z.string().describe('要读取的文件路径（相对或绝对路径）'),
      startLine: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('起始行号（从 1 开始，默认第 1 行）'),
      endLine: z.number().int().positive().optional().describe('结束行号（包含，默认到最后一行）'),
    }),
  },
);
