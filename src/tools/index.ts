import { getCurrentTime } from './get-current-time.ts';
import { fileRead } from './file-read.ts';
import { fileWrite } from './file-write.ts';
import { fileList } from './file-list.ts';
import { bashExecute } from './bash-execute.ts';

/** 所有注册工具的列表，agent 和 prompt 共用同一份，无需手动同步 */
export const tools = [getCurrentTime, fileRead, fileWrite, fileList, bashExecute];

export { getCurrentTime, fileRead, fileWrite, fileList, bashExecute };
