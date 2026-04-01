import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getRequestCwd } from './request-context.ts';

/**
 * 动态上下文构建模块。
 *
 * 参考 Claude Code 的 context.ts：在每次会话开始时，自动收集当前项目的
 * 工作目录、git 状态、文件结构等信息，注入 System Prompt。
 * 这样 agent 不需要先调用工具就能了解项目概况，大幅提升首轮回答质量。
 */

/** 安全执行命令，失败返回 null */
function safeExec(cmd: string, args: string[], cwd: string): string | null {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/** 获取 git 分支名和简要状态 */
export function getGitInfo(): string | null {
  const cwd = getRequestCwd();
  const branch = safeExec('git', ['branch', '--show-current'], cwd);
  if (!branch) return null;

  const status = safeExec('git', ['status', '--short'], cwd);

  const parts = [`分支: ${branch}`];
  if (status) {
    const lines = status.split('\n').filter(Boolean);
    parts.push(
      `变更文件 (${lines.length} 个):\n${lines.slice(0, 15).join('\n')}${lines.length > 15 ? '\n...' : ''}`,
    );
  } else {
    parts.push('工作区干净');
  }

  return parts.join('\n');
}

/** 获取项目顶层文件结构（1 层） */
export function getProjectStructure(): string {
  const cwd = getRequestCwd();
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    const lines: string[] = [];

    const sorted = entries
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of sorted) {
      lines.push(entry.isDirectory() ? `📁 ${entry.name}/` : `📄 ${entry.name}`);
    }

    return lines.join('\n');
  } catch {
    return '(无法读取目录)';
  }
}

/** 尝试读取项目的 AGENT.md 或 CLAUDE.md 记忆文件 */
export function getMemoryFile(): string | null {
  const candidates = ['AGENT.md', 'CLAUDE.md'];
  for (const name of candidates) {
    try {
      const content = readFileSync(join(getRequestCwd(), name), 'utf-8').trim();
      if (content) return `[${name}]\n${content}`;
    } catch {
      // 文件不存在，继续尝试下一个
    }
  }
  return null;
}

/**
 * 构建完整的动态上下文字符串，供 System Prompt 使用。
 * 每次新会话开始时调用一次即可。
 */
export function buildContext(): string {
  const sections: string[] = [];

  sections.push(`工作目录: ${getRequestCwd()}`);

  const git = getGitInfo();
  if (git) sections.push(`Git 信息:\n${git}`);

  sections.push(`项目结构:\n${getProjectStructure()}`);

  const memory = getMemoryFile();
  if (memory) sections.push(`项目记忆:\n${memory}`);

  return sections.join('\n\n');
}
