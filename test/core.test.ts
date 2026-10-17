import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb } from '../src/db.ts';
import { signShopee, createShopeeClient, parseShopeeUrl } from '../src/providers/shopee.ts';
import { buildMlAffiliateLink, parseMlItemId, isReadyAffiliateLink } from '../src/providers/mercadolivre.ts';
import { createZapsterClient, normalizeGroupRecipient } from '../src/zapster.ts';
import { renderMessage } from '../src/message.ts';
import { createDispatcher } from '../src/dispatcher.ts';
import { extractGroupsFromPayload } from '../src/app.ts';

const noSleep = async () => {};
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

test('assinatura Shopee = sha256(appId + ts + payload + secret)', () => {
  const expected = createHash('sha256').update('123' + '1700000000' + '{"query":"x"}' + 'sec').digest('hex');
  assert.equal(signShopee('123', 'sec', 1700000000, '{"query":"x"}'), expected);
});

test('cliente Shopee envia header SHA256 e assina o corpo exato', async () => {
  let seen: { headers: any; body: string } | null = null;
  const client = createShopeeClient(
    { endpoint: 'https://x/graphql', appId: 'APP', secret: 'SEC' },
    (async (_url: string, init: any) => {
      seen = { headers: init.headers, body: init.body };
      return json({ data: { generateShortLink: { shortLink: 'https://s.shopee.com.br/abc' } } });
    }) as any,
  );
  assert.equal(await client.generateShortLink('https://shopee.com.br/x-i.1.2'), 'https://s.shopee.com.br/abc');
  const m = seen!.headers.Authorization.match(/^SHA256 Credential=APP, Timestamp=(\d+), Signature=([a-f0-9]{64})$/);
  assert.ok(m);
  assert.equal(m[2], signShopee('APP', 'SEC', Number(m[1]), seen!.body));
});

test('parse de URLs Shopee e Mercado Livre', () => {
  assert.deepEqual(parseShopeeUrl('https://shopee.com.br/Fone-i.123.456?x=1'), { shopId: '123', itemId: '456' });
  assert.deepEqual(parseShopeeUrl('https://shopee.com.br/product/11/22'), { shopId: '11', itemId: '22' });
  assert.equal(parseMlItemId('https://produto.mercadolivre.com.br/MLB-1234567890-fone-_JM'), 'MLB1234567890');
  assert.equal(parseMlItemId('https://www.mercadolivre.com.br/p/MLB19615345'), 'MLB19615345');
});

test('link de afiliado ML: anexa matt_word/matt_tool ou mantém link pronto', () => {
  const cfg = { mattWord: 'matt:wellington:123456', mattTool: '', accessToken: '' };
  const link = new URL(buildMlAffiliateLink('https://produto.mercadolivre.com.br/MLB-1-x#pos', cfg));
  assert.equal(link.searchParams.get('matt_word'), 'wellington');
  assert.equal(link.searchParams.get('matt_tool'), '123456');
  assert.equal(link.hash, '');
  assert.ok(isReadyAffiliateLink('https://mercadolivre.com/sec/1abc23'));
  assert.equal(buildMlAffiliateLink('https://mercadolivre.com/sec/1abc23', cfg), 'https://mercadolivre.com/sec/1abc23');
  assert.throws(() => buildMlAffiliateLink('https://produto.mercadolivre.com.br/MLB-1', { ...cfg, mattWord: '' }));
});

test('recipient de grupo no formato da Zapster', () => {
  assert.equal(normalizeGroupRecipient('120363012345678901@g.us'), 'group:120363012345678901');
  assert.equal(normalizeGroupRecipient('group:999'), 'group:999');
});

test('mensagem: remove linhas com variável vazia', () => {
  const base = { id: 1, platform: 'shopee' as const, external_id: null, commission_rate: null, image_url: null, product_url: 'u', affiliate_link: 'https://s.shopee.com.br/x', created_at: '' };
  const withDiscount = renderMessage({ ...base, title: 'Fone', price: 50, original_price: 100, discount_pct: null });
  assert.match(withDiscount, /~De R\$\s?100,00~/);
  assert.match(withDiscount, /50% OFF/);
  const plain = renderMessage({ ...base, title: 'Fone', price: 50, original_price: null, discount_pct: null });
  assert.doesNotMatch(plain, /~De/);
  assert.doesNotMatch(plain, /OFF/);
  assert.match(plain, /https:\/\/s\.shopee\.com\.br\/x/);
});

test('Zapster: refaz a chamada após 429 respeitando Retry-After', async () => {
  const calls: any[] = [];
  const responses = [json({ error: 'rate_limited' }, 429, { 'Retry-After': '1' }), json({ message_id: 'm1' })];
  const z = createZapsterClient(
    { baseUrl: 'https://api.zapsterapi.com/v1', token: 'T', instanceId: 'I', sendDelayMs: 0, webhookSecret: '' },
    (async (url: string, init: any) => (calls.push({ url, init }), responses.shift()!)) as any,
    noSleep,
  );
  const r = await z.sendMessage({ recipient: 'group:1', text: 'oi', imageUrl: 'https://img/x.jpg' });
  assert.equal(r.messageId, 'm1');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.zapsterapi.com/v1/wa/messages');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer T');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.media, { url: 'https://img/x.jpg', caption: 'oi' });
  assert.equal(body.instance_id, 'I');
});

test('dispatcher: envia para grupos ativos, registra falhas e faz rodízio em recorrentes', async () => {
  const repo = openDb(':memory:');
  const g1 = repo.upsertGroup('A', 'group:1');
  const g2 = repo.upsertGroup('B', 'group:2');
  const g3 = repo.upsertGroup('C', 'group:3');
  repo.setGroupActive(g3.id, false);
  const mk = (title: string) =>
    repo.createOffer({ platform: 'shopee', external_id: null, title, price: 10, original_price: null, discount_pct: null, commission_rate: null, image_url: null, product_url: 'u', affiliate_link: 'https://l/' + title });
  const o1 = mk('um');
  const o2 = mk('dois');

  const sent: any[] = [];
  const zapster = {
    async sendMessage(i: any) {
      if (i.recipient === 'group:2') throw new Error('instância offline');
      sent.push(i);
      return { messageId: 'x' };
    },
    listInstances: async () => ({}),
  };
  const d = createDispatcher(repo, zapster as any, 0, noSleep);

  const s = await d.dispatchOffer(o1.id, [g1.id, g2.id, g3.id]);
  assert.equal(s.sent, 1);
  assert.equal(s.failed, 1);
  assert.equal(repo.listSends().length, 2);

  const camp = repo.createCampaign({ name: 'r', template: null, group_ids: [g1.id], offer_ids: [o1.id, o2.id], mode: 'recurring', run_at: null, cron: '0 9 * * *', send_image: 0 });
  sent.length = 0;
  await d.runCampaign(repo.getCampaign(camp.id)!);
  await d.runCampaign(repo.getCampaign(camp.id)!);
  await d.runCampaign(repo.getCampaign(camp.id)!);
  assert.deepEqual(sent.map((m) => m.text.includes('https://l/um') ? 'um' : 'dois'), ['um', 'dois', 'um']);

  const once = repo.createCampaign({ name: 'o', template: null, group_ids: [g1.id], offer_ids: [o1.id, o2.id], mode: 'once', run_at: '2020-01-01T00:00:00.000Z', cron: null, send_image: 1 });
  assert.equal(repo.dueOnceCampaigns(new Date().toISOString()).length, 1);
  await d.runCampaign(repo.getCampaign(once.id)!);
  assert.equal(repo.getCampaign(once.id)!.active, 0);
  assert.equal(repo.dueOnceCampaigns(new Date().toISOString()).length, 0);
});

test('webhook: extrai grupos do payload', () => {
  const groups = extractGroupsFromPayload({
    type: 'message.received',
    data: { chat: { id: '120363012345678901@g.us', name: 'Promoções VIP' }, sender: { id: '5511999999999@s.whatsapp.net' } },
  });
  assert.deepEqual(groups, [{ recipient: 'group:120363012345678901', name: 'Promoções VIP' }]);
});

test('configurações do painel sobrescrevem o env e mascaram segredos', async () => {
  const { loadSettings, saveSettings, describeSettings } = await import('../src/settings.ts');
  const repo = openDb(':memory:');
  const cfg: any = {
    zapster: { token: '', instanceId: '', sendDelayMs: 4000 },
    shopee: { appId: '', secret: '' },
    mercadoLivre: { mattWord: '', mattTool: '', accessToken: '' },
  };
  saveSettings(repo, cfg, { ZAPSTER_TOKEN: 'abc123456', SHOPEE_APP_ID: '999', SEND_DELAY_MS: '6000', ML_MATT_WORD: '  ', HACK: 'x' });
  assert.equal(cfg.zapster.token, 'abc123456');
  assert.equal(cfg.zapster.sendDelayMs, 6000);
  assert.equal(repo.getSettings().HACK, undefined);
  const d = describeSettings(cfg);
  assert.equal(d.find((s) => s.key === 'ZAPSTER_TOKEN')!.value, '••••3456');
  assert.equal(d.find((s) => s.key === 'SHOPEE_APP_ID')!.value, '999');
  const fresh: any = structuredClone({ ...cfg, zapster: { token: '', instanceId: '', sendDelayMs: 4000 } });
  loadSettings(repo, fresh);
  assert.equal(fresh.zapster.token, 'abc123456');
});
