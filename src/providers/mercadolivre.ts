import type { Config } from '../config.ts';

// O Mercado Livre não oferece API pública para gerar links de afiliado.
// Estratégia:
//  1. Se o usuário colar um link já gerado no painel de afiliados (mercadolivre.com/sec/..., meli.la/...),
//     ele é usado como está.
//  2. Se colar a URL do produto, anexamos matt_word/matt_tool (a etiqueta do link builder do usuário).
// Dados do anúncio (título, preço, foto) vêm da API pública api.mercadolibre.com, que pode exigir
// token OAuth (ML_ACCESS_TOKEN). Sem token ou em caso de erro, o usuário preenche à mão.

export interface MlItem {
  id: string;
  title: string;
  price: number | null;
  originalPrice: number | null;
  imageUrl: string | null;
  permalink: string;
}

const SHORT_AFFILIATE_HOSTS = [/^(www\.)?mercadolivre\.com$/, /^meli\.la$/];

export function isReadyAffiliateLink(url: string): boolean {
  try {
    const u = new URL(url);
    if (SHORT_AFFILIATE_HOSTS.some((re) => re.test(u.hostname))) return true;
    return u.searchParams.has('matt_tool') || u.searchParams.has('matt_word');
  } catch {
    return false;
  }
}

/** Extrai o ID do anúncio (MLB123...) de uma URL do Mercado Livre. */
export function parseMlItemId(url: string): string | null {
  const m = url.match(/\b(MLB)-?(\d{6,})/i);
  return m ? `${m[1].toUpperCase()}${m[2]}` : null;
}

/** Aceita "matt:USUARIO:TOOLID" em mattWord ou os dois valores separados. */
export function resolveMattParams(mattWord: string, mattTool: string): { word: string; tool: string } {
  const combined = mattWord.match(/^matt:([^:]+):(.+)$/);
  if (combined) return { word: combined[1], tool: combined[2] };
  return { word: mattWord, tool: mattTool };
}

export function buildMlAffiliateLink(productUrl: string, cfg: Config['mercadoLivre']): string {
  if (isReadyAffiliateLink(productUrl)) return productUrl;
  const { word, tool } = resolveMattParams(cfg.mattWord, cfg.mattTool);
  if (!word || !tool) {
    throw new Error(
      'Configure ML_MATT_WORD e ML_MATT_TOOL, ou cole um link já gerado no painel de afiliados do Mercado Livre',
    );
  }
  const u = new URL(productUrl);
  u.hash = '';
  u.searchParams.set('matt_word', word);
  u.searchParams.set('matt_tool', tool);
  return u.toString();
}

export function createMlClient(cfg: Config['mercadoLivre'], fetchFn: typeof fetch = fetch) {
  return {
    async fetchItem(itemId: string): Promise<MlItem> {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (cfg.accessToken) headers.Authorization = `Bearer ${cfg.accessToken}`;
      const res = await fetchFn(`https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`, { headers });
      if (!res.ok) throw new Error(`Mercado Livre API: HTTP ${res.status} ao buscar ${itemId}`);
      const it = (await res.json()) as any;
      return {
        id: it.id,
        title: it.title,
        price: it.price ?? null,
        originalPrice: it.original_price ?? null,
        imageUrl: it.pictures?.[0]?.secure_url ?? it.thumbnail ?? null,
        permalink: it.permalink,
      };
    },
  };
}

export type MlClient = ReturnType<typeof createMlClient>;
