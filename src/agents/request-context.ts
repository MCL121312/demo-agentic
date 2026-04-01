import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve as pathResolve } from 'node:path';

/**
 * 请求级上下文，用 AsyncLocalStorage 实现。
 *
 * 解决的问题：agent 通过 HTTP API 被调用时，不同请求可能想操作不同的项目目录。
 * 工具里 resolve(path) 需要知道"当前请求的工作目录"，而不是服务进程的 cwd。
 *
 * 用法：
 *   1. 路由层：runWithCwd(cwd, async () => { ... })
 *   2. 工具层：resolvePath('src/app.ts') → 基于请求 cwd 解析
 */

interface RequestStore {
  /** 当前请求的工作目录 */
  cwd: string;
}

const storage = new AsyncLocalStorage<RequestStore>();

/**
 * 在指定 cwd 上下文中运行异步函数。
 * 在这个函数内部（包括它调用的所有异步操作），resolvePath() 都会基于这个 cwd。
 */
export function runWithCwd<T>(cwd: string, fn: () => T): T {
  return storage.run({ cwd }, fn);
}

/**
 * 获取当前请求的工作目录。
 * 如果不在 runWithCwd 上下文中（比如测试），回退到 process.cwd()。
 */
export function getRequestCwd(): string {
  return storage.getStore()?.cwd ?? process.cwd();
}

/**
 * 基于当前请求的 cwd 解析路径。
 * 所有工具应使用这个函数代替 path.resolve()。
 */
export function resolvePath(path: string): string {
  return pathResolve(getRequestCwd(), path);
}

