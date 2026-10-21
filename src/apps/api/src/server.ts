import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp(config);
try {
  await app.listen({ port: config.port, host: config.host });
} catch (e) {
  app.log.error(e);
  process.exit(1);
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
