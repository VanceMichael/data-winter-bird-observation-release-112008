// 应用入口：等待来源就绪后启动本地服务。
// SOURCE_BASE 指向合成上游，APP_PORT/PORT 控制本地监听端口。
import { once } from 'node:events';
import { Ledger } from './state.mjs';
import { createApp } from './server.mjs';
import { waitForHealth } from './source-client.mjs';

const sourceBase = process.env.SOURCE_BASE ?? 'http://127.0.0.1:4173';
const port = Number(process.env.APP_PORT ?? process.env.PORT ?? 4183);

await waitForHealth(sourceBase);
const ledger = new Ledger();
const server = createApp(ledger, sourceBase);
server.listen(port, '127.0.0.1');
await once(server, 'listening');
process.stdout.write(`巡护合成应用 http://127.0.0.1:${server.address().port} 来源 ${sourceBase}\n`);
