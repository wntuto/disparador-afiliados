import type { Campaign, Repo } from './db.ts';
import type { ZapsterClient } from './zapster.ts';
import { renderMessage } from './message.ts';

export interface DispatchOptions {
  campaignId?: number | null;
  template?: string | null;
  sendImage?: boolean;
}

export interface DispatchSummary {
  sent: number;
  failed: number;
  errors: string[];
}

export function createDispatcher(
  repo: Repo,
  zapster: ZapsterClient,
  sendDelayMs: number,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
) {
  const running = new Set<number>();

  async function dispatchOffer(offerId: number, groupIds: number[], opts: DispatchOptions = {}): Promise<DispatchSummary> {
    const offer = repo.getOffer(offerId);
    if (!offer) throw new Error(`Oferta ${offerId} não encontrada`);
    const groups = groupIds.map((id) => repo.getGroup(id)).filter((g) => g && g.active);
    const text = renderMessage(offer, opts.template);
    const summary: DispatchSummary = { sent: 0, failed: 0, errors: [] };

    for (const [i, group] of groups.entries()) {
      if (i > 0 && sendDelayMs > 0) await sleep(sendDelayMs);
      try {
        const { messageId } = await zapster.sendMessage({
          recipient: group!.recipient,
          text,
          imageUrl: opts.sendImage === false ? null : offer.image_url,
        });
        repo.logSend({ campaign_id: opts.campaignId ?? null, offer_id: offer.id, group_id: group!.id, status: 'sent', message_id: messageId, error: null });
        summary.sent++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        repo.logSend({ campaign_id: opts.campaignId ?? null, offer_id: offer.id, group_id: group!.id, status: 'failed', message_id: null, error: msg });
        summary.failed++;
        summary.errors.push(`${group!.name}: ${msg}`);
      }
    }
    return summary;
  }

  /**
   * manual / once: envia todas as ofertas da campanha para todos os grupos.
   * recurring: a cada execução envia a próxima oferta da lista (rodízio), para não repetir a mesma.
   */
  async function runCampaign(campaign: Campaign): Promise<DispatchSummary> {
    if (running.has(campaign.id)) return { sent: 0, failed: 0, errors: ['Campanha já está em execução'] };
    running.add(campaign.id);
    try {
      const total: DispatchSummary = { sent: 0, failed: 0, errors: [] };
      if (!campaign.offer_ids.length) {
        total.errors.push('Campanha sem ofertas');
        return total;
      }
      const isRecurring = campaign.mode === 'recurring';
      const index = campaign.next_offer_index % campaign.offer_ids.length;
      const offerIds = isRecurring ? [campaign.offer_ids[index]] : campaign.offer_ids;

      for (const [i, offerId] of offerIds.entries()) {
        if (i > 0 && sendDelayMs > 0) await sleep(sendDelayMs);
        const s = await dispatchOffer(offerId, campaign.group_ids, {
          campaignId: campaign.id,
          template: campaign.template,
          sendImage: !!campaign.send_image,
        });
        total.sent += s.sent;
        total.failed += s.failed;
        total.errors.push(...s.errors);
      }
      repo.markCampaignRun(campaign.id, isRecurring ? index + 1 : 0, campaign.mode === 'once');
      return total;
    } finally {
      running.delete(campaign.id);
    }
  }

  return { dispatchOffer, runCampaign };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
