import { config } from './config.ts';
import { openDb } from './db.ts';
import { createShopeeClient } from './providers/shopee.ts';
import { createMlClient } from './providers/mercadolivre.ts';
import { createZapsterClient } from './zapster.ts';
import { createDispatcher } from './dispatcher.ts';
import { createScheduler } from './scheduler.ts';
import { buildApp } from './app.ts';

const repo = openDb(config.dbPath);
const shopee = createShopeeClient(config.shopee);
const ml = createMlClient(config.mercadoLivre);
const zapster = createZapsterClient(config.zapster);
const dispatcher = createDispatcher(repo, zapster, config.zapster.sendDelayMs);
const scheduler = createScheduler(repo, dispatcher, config.timezone);

const app = await buildApp({ config, repo, shopee, ml, dispatcher, scheduler });

if (!config.panelPassword) app.log.warn('PANEL_PASSWORD vazio: painel sem senha. Use só em ambiente local.');

scheduler.start();
await app.listen({ port: config.port, host: '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    scheduler.stop();
    await app.close();
    process.exit(0);
  });
}
