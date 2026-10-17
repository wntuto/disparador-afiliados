import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import cron from 'node-cron';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config.ts';
import type { Repo } from './db.ts';
import type { ShopeeClient } from './providers/shopee.ts';
import { parseShopeeUrl } from './providers/shopee.ts';
import type { MlClient } from './providers/mercadolivre.ts';
import { buildMlAffiliateLink, parseMlItemId } from './providers/mercadolivre.ts';
import type { Dispatcher } from './dispatcher.ts';
import type { Scheduler } from './scheduler.ts';
import { normalizeGroupRecipient } from './zapster.ts';
import { DEFAULT_TEMPLATE, renderMessage } from './message.ts';
import type { ZapsterClient } from './zapster.ts';
import { describeSettings, saveSettings } from './settings.ts';

export interface AppDeps {
  config: Config;
  repo: Repo;
  shopee: ShopeeClient;
  ml: MlClient;
  dispatcher: Dispatcher;
  scheduler: Pick<Scheduler, 'sync' | 'scheduledCount'>;
  zapster?: ZapsterClient;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const optionalNumber = z.coerce.number().nonnegative().nullable().optional();

const offerOverrides = z.object({
  title: z.string().min(1).optional(),
  price: optionalNumber,
  original_price: optionalNumber,
  image_url: z.string().url().nullable().optional(),
});

const campaignBody = z
  .object({
    name: z.string().min(1),
    template: z.string().nullable().optional(),
    group_ids: z.array(z.number().int()).min(1),
    offer_ids: z.array(z.number().int()).min(1),
    mode: z.enum(['manual', 'once', 'recurring']),
    run_at: z.string().datetime({ offset: true }).nullable().optional(),
    cron: z.string().nullable().optional(),
    send_image: z.boolean().default(true),
  })
  .refine((c) => c.mode !== 'once' || !!c.run_at, { message: 'run_at é obrigatório para disparo único', path: ['run_at'] })
  .refine((c) => c.mode !== 'recurring' || (!!c.cron && cron.validate(c.cron)), {
    message: 'Expressão cron inválida',
    path: ['cron'],
  });

function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Procura IDs de grupo (…@g.us ou group:…) em qualquer ponto do payload do webhook. */
export function extractGroupsFromPayload(payload: unknown): { recipient: string; name: string | null }[] {
  const found = new Map<string, string | null>();
  const visit = (node: unknown, parent: Record<string, unknown> | null) => {
    if (typeof node === 'string') {
      const m = node.match(/^(?:group:)?(\d{10,}(?:-\d+)?)(?:@g\.us)?$/);
      if (m && (node.includes('@g.us') || node.startsWith('group:'))) {
        const name = parent && (parent.subject ?? parent.name ?? parent.group_name);
        const recipient = normalizeGroupRecipient(m[1]);
        if (!found.get(recipient)) found.set(recipient, typeof name === 'string' ? name : null);
      }
    } else if (Array.isArray(node)) node.forEach((n) => visit(n, parent));
    else if (node && typeof node === 'object') {
      for (const v of Object.values(node)) visit(v, node as Record<string, unknown>);
    }
  };
  visit(payload, null);
  return [...found].map(([recipient, name]) => ({ recipient, name }));
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, repo, shopee, ml, dispatcher, scheduler, zapster } = deps;
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    const status = (err as any).statusCode && (err as any).statusCode < 500 ? (err as any).statusCode : 502;
    return reply.status(status).send({ error: err.message });
  });

  // Basic Auth para o painel e a API (o webhook usa segredo próprio).
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/webhooks/') || req.url === '/health') return;
    if (!config.panelPassword) {
      // Em produção o painel nunca fica aberto sem senha.
      if (process.env.NODE_ENV === 'production') {
        return reply.status(503).type('text/plain; charset=utf-8')
          .send('Painel bloqueado: cadastre a variável PANEL_PASSWORD no servidor (no Railway: aba Variables) e aguarde reiniciar.');
      }
      return;
    }
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    const [user, pass] = Buffer.from(encoded ?? '', 'base64').toString().split(':');
    if (scheme !== 'Basic' || !safeEqual(user ?? '', config.panelUser) || !safeEqual(pass ?? '', config.panelPassword)) {
      reply.header('WWW-Authenticate', 'Basic realm="Disparador"').status(401).send({ error: 'Não autorizado' });
    }
  });

  await app.register(fastifyStatic, { root: fileURLToPath(new URL('../public', import.meta.url)) });

  app.get('/health', async () => ({ ok: true }));

  app.get('/api/status', async () => ({
    zapster: !!config.zapster.token,
    zapsterInstance: !!config.zapster.instanceId,
    shopee: !!(config.shopee.appId && config.shopee.secret),
    mercadoLivreTag: !!config.mercadoLivre.mattWord,
    mercadoLivreToken: !!config.mercadoLivre.accessToken,
    scheduledCampaigns: scheduler.scheduledCount(),
    defaultTemplate: DEFAULT_TEMPLATE,
    timezone: config.timezone,
  }));

  // ---- Configurações (chaves das integrações) ----
  app.get('/api/settings', async () => describeSettings(config));
  app.put('/api/settings', async (req) => {
    saveSettings(repo, config, z.record(z.string(), z.string()).parse(req.body));
    return describeSettings(config);
  });
  app.post('/api/settings/test-zapster', async () => {
    if (!zapster) return { ok: false, error: 'indisponível' };
    const r = await zapster.listInstances();
    const list = (r?.instances ?? r?.data ?? []) as any[];
    const mine = list.find((i) => i.id === config.zapster.instanceId);
    return { ok: true, instances: list.length, instanceFound: !!mine, instanceStatus: mine?.status ?? null };
  });

  // ---- Grupos ----
  app.get('/api/groups', async () => repo.listGroups());
  app.post('/api/groups', async (req) => {
    const b = z.object({ name: z.string().min(1), recipient: z.string().min(5) }).parse(req.body);
    return repo.upsertGroup(b.name, normalizeGroupRecipient(b.recipient));
  });
  app.patch('/api/groups/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ active: z.boolean() }).parse(req.body);
    repo.setGroupActive(id, b.active);
    return repo.getGroup(id);
  });
  app.delete('/api/groups/:id', async (req) => {
    repo.deleteGroup(idParam.parse(req.params).id);
    return { ok: true };
  });

  // ---- Shopee: busca de produtos com comissão ----
  app.get('/api/shopee/search', async (req) => {
    const q = z
      .object({
        keyword: z.string().min(1),
        sortType: z.coerce.number().int().min(1).max(5).optional(),
        page: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().positive().max(50).optional(),
      })
      .parse(req.query);
    return shopee.searchProducts(q);
  });

  // ---- Ofertas ----
  app.get('/api/offers', async () => repo.listOffers());
  app.delete('/api/offers/:id', async (req) => {
    repo.deleteOffer(idParam.parse(req.params).id);
    return { ok: true };
  });

  /** Importa uma oferta a partir de um link da Shopee ou do Mercado Livre. */
  app.post('/api/offers/import', async (req) => {
    const b = offerOverrides.extend({ url: z.string().url() }).parse(req.body);
    const host = new URL(b.url).hostname;

    if (/shopee\./.test(host) || /shp\.ee$/.test(host)) {
      const ids = parseShopeeUrl(b.url);
      const product = ids ? (await shopee.searchProducts({ itemId: ids.itemId, shopId: ids.shopId, limit: 1 })).items[0] : undefined;
      const affiliate = product?.offerLink ?? (await shopee.generateShortLink(b.url));
      return repo.createOffer({
        platform: 'shopee',
        external_id: product?.itemId ?? ids?.itemId ?? null,
        title: b.title ?? product?.productName ?? 'Oferta Shopee',
        price: b.price ?? product?.priceMin ?? product?.price ?? null,
        original_price: b.original_price ?? null,
        discount_pct: product?.priceDiscountRate || null,
        commission_rate: product?.commissionRate ?? null,
        image_url: b.image_url ?? product?.imageUrl ?? null,
        product_url: product?.productLink ?? b.url,
        affiliate_link: affiliate,
      });
    }

    if (/mercadoli(vre|bre)\.com|meli\.la$/.test(host)) {
      const itemId = parseMlItemId(b.url);
      let item = null;
      if (itemId) item = await ml.fetchItem(itemId).catch((e) => (req.log.warn(e.message), null));
      if (!item && !b.title) {
        const err: any = new Error('Não consegui ler o anúncio do Mercado Livre; informe o título (e o preço) manualmente');
        err.statusCode = 422;
        throw err;
      }
      return repo.createOffer({
        platform: 'mercadolivre',
        external_id: item?.id ?? itemId,
        title: b.title ?? item!.title,
        price: b.price ?? item?.price ?? null,
        original_price: b.original_price ?? item?.originalPrice ?? null,
        discount_pct: null,
        commission_rate: null,
        image_url: b.image_url ?? item?.imageUrl ?? null,
        product_url: item?.permalink ?? b.url,
        affiliate_link: buildMlAffiliateLink(b.url, config.mercadoLivre),
      });
    }

    const err: any = new Error('Link não reconhecido: use um link da Shopee ou do Mercado Livre');
    err.statusCode = 400;
    throw err;
  });

  /** Salva um produto vindo da busca da Shopee (já tem o offerLink de afiliado). */
  app.post('/api/offers/shopee', async (req) => {
    const p = z
      .object({
        itemId: z.string(),
        productName: z.string(),
        priceMin: z.number().nullable(),
        price: z.number().nullable(),
        priceDiscountRate: z.number().nullable(),
        commissionRate: z.number().nullable(),
        imageUrl: z.string().nullable(),
        productLink: z.string(),
        offerLink: z.string().url(),
      })
      .parse(req.body);
    return repo.createOffer({
      platform: 'shopee',
      external_id: p.itemId,
      title: p.productName,
      price: p.priceMin ?? p.price,
      original_price: null,
      discount_pct: p.priceDiscountRate || null,
      commission_rate: p.commissionRate,
      image_url: p.imageUrl,
      product_url: p.productLink,
      affiliate_link: p.offerLink,
    });
  });

  app.post('/api/preview', async (req) => {
    const b = z.object({ offer_id: z.number().int(), template: z.string().nullable().optional() }).parse(req.body);
    const offer = repo.getOffer(b.offer_id);
    if (!offer) return { text: '' };
    return { text: renderMessage(offer, b.template), image_url: offer.image_url };
  });

  // ---- Disparo manual imediato ----
  app.post('/api/send', async (req) => {
    const b = z
      .object({
        offer_id: z.number().int(),
        group_ids: z.array(z.number().int()).min(1),
        template: z.string().nullable().optional(),
        send_image: z.boolean().default(true),
      })
      .parse(req.body);
    return dispatcher.dispatchOffer(b.offer_id, b.group_ids, { template: b.template, sendImage: b.send_image });
  });

  // ---- Campanhas (manuais reutilizáveis, únicas agendadas ou recorrentes) ----
  app.get('/api/campaigns', async () => repo.listCampaigns());
  app.post('/api/campaigns', async (req) => {
    const b = campaignBody.parse(req.body);
    const c = repo.createCampaign({
      name: b.name,
      template: b.template ?? null,
      group_ids: b.group_ids,
      offer_ids: b.offer_ids,
      mode: b.mode,
      run_at: b.mode === 'once' ? new Date(b.run_at!).toISOString() : null,
      cron: b.mode === 'recurring' ? b.cron! : null,
      send_image: b.send_image ? 1 : 0,
    });
    scheduler.sync();
    return c;
  });
  app.post('/api/campaigns/:id/run', async (req) => {
    const c = repo.getCampaign(idParam.parse(req.params).id);
    if (!c) return { error: 'Campanha não encontrada' };
    return dispatcher.runCampaign(c);
  });
  app.patch('/api/campaigns/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    repo.setCampaignActive(id, z.object({ active: z.boolean() }).parse(req.body).active);
    scheduler.sync();
    return repo.getCampaign(id);
  });
  app.delete('/api/campaigns/:id', async (req) => {
    repo.deleteCampaign(idParam.parse(req.params).id);
    scheduler.sync();
    return { ok: true };
  });

  app.get('/api/sends', async () => repo.listSends(200));

  // ---- Webhook da Zapster: cadastra automaticamente os grupos em que chegam mensagens ----
  app.post('/webhooks/zapster', async (req, reply) => {
    const secret = (req.query as Record<string, string>).secret ?? '';
    if (config.zapster.webhookSecret && !safeEqual(secret, config.zapster.webhookSecret)) {
      return reply.status(401).send({ error: 'segredo inválido' });
    }
    const known = new Set(repo.listGroups().map((g) => g.recipient));
    let added = 0;
    for (const g of extractGroupsFromPayload(req.body)) {
      if (known.has(g.recipient) && !g.name) continue;
      const existing = repo.listGroups().find((x) => x.recipient === g.recipient);
      repo.upsertGroup(g.name ?? existing?.name ?? `Grupo ${g.recipient.slice(6, 14)}…`, g.recipient);
      if (!existing) added++;
    }
    return { ok: true, added };
  });

  return app;
}
