import { getCurrentTime } from './get-current-time.ts';

/** 所有注册工具的列表，agent 和 prompt 共用同一份，无需手动同步 */
export const tools = [getCurrentTime];

export { getCurrentTime };
