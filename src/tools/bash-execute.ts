import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { getRequestCwd } from '../agents/request-context.ts';

/** 最大输出长度（字符），防止 agent 收到巨量输出 */
const MAX_OUTPUT_LENGTH = 8000;

/** 默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 30_000;

export const bashExecute = tool(
  async ({ command, timeout }) => {
    const timeoutMs = (timeout ?? 30) * 1000;

    return new Promise<string>(resolve => {
      // 使用 execFile 调用 bash -c，比 exec 更安全
      const child = execFile(
        '/bin/bash',
        ['-c', command],
        {
          cwd: getRequestCwd(),
          timeout: Math.min(timeoutMs, DEFAULT_TIMEOUT_MS),
          maxBuffer: 1024 * 1024, // 1MB
          env: { ...process.env, LANG: 'zh_CN.UTF-8' },
        },
        (error, stdout, stderr) => {
          const parts: string[] = [];

          if (stdout) {
            const out =
              stdout.length > MAX_OUTPUT_LENGTH
                ? stdout.slice(0, MAX_OUTPUT_LENGTH) + '\n...(输出已截断)'
                : stdout;
            parts.push(`[stdout]\n${out}`);
          }

          if (stderr) {
            const err =
              stderr.length > MAX_OUTPUT_LENGTH
                ? stderr.slice(0, MAX_OUTPUT_LENGTH) + '\n...(输出已截断)'
                : stderr;
            parts.push(`[stderr]\n${err}`);
          }

          if (error) {
            if (error.killed) {
              parts.push(`[error] 命令执行超时（${timeout ?? 30}s），已强制终止`);
            } else {
              parts.push(`[exit_code] ${error.code ?? 1}`);
            }
          } else {
            parts.push('[exit_code] 0');
          }

          resolve(parts.join('\n\n') || '[无输出]');
        },
      );
    });
  },
  {
    name: 'bash_execute',
    description:
      '在 bash shell 中执行命令并返回 stdout、stderr 和退出码。超时默认 30 秒。用于运行构建、测试、git 操作等。',
    schema: z.object({
      command: z.string().describe('要执行的 bash 命令'),
      timeout: z.number().int().min(1).max(30).optional().describe('超时秒数，默认 30，最大 30'),
    }),
  },
);
