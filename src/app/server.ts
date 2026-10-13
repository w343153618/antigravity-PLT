import { buildApp } from './app.ts';
import { readServerConfig } from './config.ts';

const config = readServerConfig();
const app = await buildApp({
  databasePath: config.databasePath, seed: config.seed, logger: true,
  ...(process.env.AUTH_BOOTSTRAP_PASSWORD ? { bootstrapPassword: process.env.AUTH_BOOTSTRAP_PASSWORD } : {}),
  secureCookies: process.env.COOKIE_SECURE === 'true',
});
try {
  const address = await app.listen({ host: config.host, port: config.port });
  console.log(`门店档案服务已启动：${address}`);
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void app.close().then(() => { process.exitCode = 0; }).catch(error => {
      app.log.error(error, 'Failed to close the records service');
      process.exitCode = 1;
    });
  });
}
