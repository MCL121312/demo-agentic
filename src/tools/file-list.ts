import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePath } from '../agents/request-context.ts';

/**
 * 递归列出目录内容，最多到指定深度。
 * 参考 Claude Code 的 GlobTool：让 agent 了解项目结构是工作的前提。
 */
async function listDir(dir: string, maxDepth: number, currentDepth = 0): Promise<string[]> {
  if (currentDepth >= maxDepth) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  // 按名称排序，目录在前
  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    // 跳过隐藏文件和 node_modules
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const fullPath = join(dir, entry.name);
    const prefix = '  '.repeat(currentDepth);

    if (entry.isDirectory()) {
      results.push(`${prefix}📁 ${entry.name}/`);
      const children = await listDir(fullPath, maxDepth, currentDepth + 1);
      results.push(...children);
    } else {
      const info = await stat(fullPath);
      const size = formatSize(info.size);
      results.push(`${prefix}📄 ${entry.name} (${size})`);
    }
  }

  return results;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export const fileList = tool(
  async ({ path, maxDepth }) => {
    try {
      const absPath = resolvePath(path ?? '.');
      const lines = await listDir(absPath, maxDepth ?? 2);

      if (lines.length === 0) {
        return `目录为空或深度为 0: ${absPath}`;
      }

      return `目录: ${absPath}\n\n${lines.join('\n')}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `列出目录失败: ${msg}`;
    }
  },
  {
    name: 'file_list',
    description:
      '列出目录下的文件和子目录，可控制递归深度。默认列出 2 层。自动跳过 node_modules 和隐藏文件。',
    schema: z.object({
      path: z.string().optional().describe('目录路径，默认为当前工作目录'),
      maxDepth: z.number().int().min(1).max(5).optional().describe('递归深度，默认 2，最大 5'),
    }),
  },
);
