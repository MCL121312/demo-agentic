import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { networkInterfaces } from 'node:os';
import chatRouter from './chat/chat.ts';

// 服务配置
const PORT = process.env.PORT || 3000;

/** 打印启动信息 */
export function printStartupInfo() {
  const localUrl = `http://localhost:${PORT}`;
  const networkUrl = `http://${getNetworkIP()}:${PORT}`;

  console.log('🚀 服务已启动');
  console.log(`本地:   ${localUrl}`);
  console.log(`网络:   ${networkUrl}`);
}

/** 获取本机网络 IP */
function getNetworkIP(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const app = new Hono();

app.use(logger());

app.get('/', c => c.json({ routes: ['/chat'] }));
app.route('/chat', chatRouter);

export default app;
