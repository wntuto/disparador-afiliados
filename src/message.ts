import type { Offer } from './db.ts';

// Modelo padrão da mensagem. Variáveis: {titulo} {preco} {preco_original} {desconto} {link} {loja}
// Linhas que contêm uma variável vazia são removidas (ex.: oferta sem preço original).
export const DEFAULT_TEMPLATE = `🔥 *{titulo}*

~De {preco_original}~
💰 *Por {preco}* ({desconto} OFF)

🛒 Compre aqui: {link}

_{loja}_`;

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatPrice(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : brl.format(v);
}

export function renderMessage(offer: Offer, template?: string | null): string {
  const discount =
    offer.discount_pct ??
    (offer.original_price && offer.price && offer.original_price > offer.price
      ? Math.round((1 - offer.price / offer.original_price) * 100)
      : null);

  const vars: Record<string, string> = {
    titulo: offer.title,
    preco: formatPrice(offer.price),
    preco_original:
      offer.original_price && offer.price && offer.original_price > offer.price ? formatPrice(offer.original_price) : '',
    desconto: discount ? `${Math.round(discount)}%` : '',
    link: offer.affiliate_link,
    loja: offer.platform === 'shopee' ? 'Oferta Shopee' : 'Oferta Mercado Livre',
  };

  return (template || DEFAULT_TEMPLATE)
    .split('\n')
    .filter((line) => {
      const used = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      return used.every((k) => vars[k] !== '');
    })
    .map((line) => line.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
