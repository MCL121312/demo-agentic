import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolvePath } from '../agents/request-context.ts';

export const fileWrite = tool(
  async ({ path, content }) => {
    try {
      const absPath = resolvePath(path);

      // 自动创建父目录
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, 'utf-8');

      const lineCount = content.split('\n').length;
      return `文件已写入: ${absPath} (${lineCount} 行, ${content.length} 字符)`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `写入文件失败: ${msg}`;
    }
  },
  {
    name: 'file_write',
    description: '创建或覆写一个文件。会自动创建不存在的父目录。',
    schema: z.object({
      path: z.string().describe('要写入的文件路径（相对或绝对路径）'),
      content: z.string().describe('要写入的完整文件内容'),
    }),
  },
);
