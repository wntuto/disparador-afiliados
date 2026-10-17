import type { Offer, Repo } from './db.ts';
import type { ShopeeClient } from './providers/shopee.ts';

// Ofertas automáticas: busca na Shopee pela palavra-chave e escolhe o primeiro produto
// (na ordem pedida: mais vendidos, maior comissão...) que não foi enviado nos últimos dias
// e que atende à comissão mínima. O produto vira uma oferta salva, já com link de afiliado.

export const AUTO_REPEAT_DAYS = 7;

export function createAutoPicker(repo: Repo, shopee: ShopeeClient) {
  return async function pickShopeeOffer(keyword: string, sortType: number, minCommissionPct: number | null): Promise<Offer | null> {
    const recent = repo.recentlySentExternalIds('shopee', AUTO_REPEAT_DAYS);
    const { items } = await shopee.searchProducts({ keyword, sortType, limit: 50 });
    const product = items.find(
      (p) =>
        !recent.has(p.itemId) &&
        !!p.offerLink &&
        (minCommissionPct == null || (p.commissionRate ?? 0) * 100 >= minCommissionPct),
    );
    if (!product) return null;
    return (
      repo.findOfferByExternalId('shopee', product.itemId) ??
      repo.createOffer({
        platform: 'shopee',
        external_id: product.itemId,
        title: product.productName,
        price: product.priceMin ?? product.price,
        original_price: null,
        discount_pct: product.priceDiscountRate || null,
        commission_rate: product.commissionRate,
        image_url: product.imageUrl,
        product_url: product.productLink,
        affiliate_link: product.offerLink,
      })
    );
  };
}

export type AutoPicker = ReturnType<typeof createAutoPicker>;
