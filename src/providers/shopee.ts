import { createHash } from 'node:crypto';
import type { Config } from '../config.ts';

// Shopee Affiliate Open API (GraphQL).
// Autenticação: Authorization: SHA256 Credential={AppId}, Timestamp={ts}, Signature={sha256hex(AppId + ts + payload + Secret)}
// O payload assinado precisa ser exatamente o corpo JSON enviado.

export interface ShopeeProduct {
  itemId: string;
  productName: string;
  price: number | null;
  priceMin: number | null;
  priceMax: number | null;
  priceDiscountRate: number | null;
  commissionRate: number | null;
  sales: number | null;
  ratingStar: number | null;
  imageUrl: string | null;
  shopName: string | null;
  productLink: string;
  offerLink: string; // link de afiliado já rastreado
}

export interface ShopeeSearch {
  keyword?: string;
  itemId?: string;
  shopId?: string;
  /** 1 relevância, 2 mais vendidos, 3 preço desc, 4 preço asc, 5 maior comissão */
  sortType?: number;
  page?: number;
  limit?: number;
}

export function signShopee(appId: string, secret: string, timestamp: number, payload: string): string {
  return createHash('sha256').update(`${appId}${timestamp}${payload}${secret}`).digest('hex');
}

const PRODUCT_FIELDS = `itemId productName price priceMin priceMax priceDiscountRate commissionRate
  sales ratingStar imageUrl shopName productLink offerLink`;

function gqlString(s: string) {
  return JSON.stringify(s);
}

export function createShopeeClient(cfg: Config['shopee'], fetchFn: typeof fetch = fetch) {
  async function call<T>(query: string): Promise<T> {
    if (!cfg.appId || !cfg.secret) throw new Error('SHOPEE_APP_ID e SHOPEE_SECRET não configurados');
    const payload = JSON.stringify({ query });
    const ts = Math.floor(Date.now() / 1000);
    const signature = signShopee(cfg.appId, cfg.secret, ts, payload);
    const res = await fetchFn(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `SHA256 Credential=${cfg.appId}, Timestamp=${ts}, Signature=${signature}`,
      },
      body: payload,
    });
    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || body.errors?.length) {
      const msg = body.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
      throw new Error(`Shopee API: ${msg}`);
    }
    return body.data as T;
  }

  return {
    async searchProducts(s: ShopeeSearch): Promise<{ items: ShopeeProduct[]; hasNextPage: boolean }> {
      const args: string[] = [];
      if (s.keyword) args.push(`keyword: ${gqlString(s.keyword)}`);
      if (s.itemId) args.push(`itemId: ${Number(s.itemId)}`);
      if (s.shopId) args.push(`shopId: ${Number(s.shopId)}`);
      args.push(`sortType: ${s.sortType ?? 2}`, `page: ${s.page ?? 1}`, `limit: ${s.limit ?? 20}`);
      const data = await call<{ productOfferV2: { nodes: any[]; pageInfo: { hasNextPage: boolean } } }>(
        `{ productOfferV2(${args.join(', ')}) { nodes { ${PRODUCT_FIELDS} } pageInfo { page limit hasNextPage } } }`,
      );
      return {
        items: data.productOfferV2.nodes.map(normalizeProduct),
        hasNextPage: data.productOfferV2.pageInfo.hasNextPage,
      };
    },

    /** Gera link curto de afiliado para qualquer URL da Shopee. */
    async generateShortLink(originUrl: string, subIds: string[] = []): Promise<string> {
      const subs = subIds.length ? `, subIds: ${JSON.stringify(subIds)}` : '';
      const data = await call<{ generateShortLink: { shortLink: string } }>(
        `mutation { generateShortLink(input: { originUrl: ${gqlString(originUrl)}${subs} }) { shortLink } }`,
      );
      return data.generateShortLink.shortLink;
    },
  };
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeProduct(n: any): ShopeeProduct {
  return {
    itemId: String(n.itemId),
    productName: n.productName,
    price: num(n.price),
    priceMin: num(n.priceMin),
    priceMax: num(n.priceMax),
    priceDiscountRate: num(n.priceDiscountRate),
    commissionRate: num(n.commissionRate),
    sales: num(n.sales),
    ratingStar: num(n.ratingStar),
    imageUrl: n.imageUrl ?? null,
    shopName: n.shopName ?? null,
    productLink: n.productLink,
    offerLink: n.offerLink,
  };
}

/** Extrai itemId de URLs como shopee.com.br/Nome-i.123.456 ou shopee.com.br/product/123/456 */
export function parseShopeeUrl(url: string): { shopId: string; itemId: string } | null {
  const m = url.match(/-i\.(\d+)\.(\d+)/) ?? url.match(/\/product\/(\d+)\/(\d+)/);
  return m ? { shopId: m[1], itemId: m[2] } : null;
}

export type ShopeeClient = ReturnType<typeof createShopeeClient>;
