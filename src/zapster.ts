import type { Config } from './config.ts';

// Cliente ZapsterAPI: POST {base}/wa/messages com Authorization: Bearer <token>.
// Grupos usam recipient no formato "group:<id>". Limite padrão: 3 req/s por token,
// então serializamos as chamadas e respeitamos Retry-After em respostas 429.

export interface SendInput {
  recipient: string;
  text: string;
  imageUrl?: string | null;
}

export interface SendResult {
  messageId: string;
}

const MIN_INTERVAL_MS = 350;
const MAX_RETRIES = 3;

export function normalizeGroupRecipient(input: string): string {
  const v = input.trim();
  if (v.startsWith('group:')) return v;
  return `group:${v.replace(/@g\.us$/, '')}`;
}

export function createZapsterClient(
  cfg: Config['zapster'],
  fetchFn: typeof fetch = fetch,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
) {
  let chain: Promise<unknown> = Promise.resolve();
  let lastCall = 0;

  async function request(path: string, init: RequestInit, attempt = 0): Promise<any> {
    if (!cfg.token) throw new Error('ZAPSTER_TOKEN não configurado');
    const wait = lastCall + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();

    const res = await fetchFn(`${cfg.baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}`, ...init.headers },
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('Retry-After')) || 2 ** attempt;
      await sleep(retryAfter * 1000);
      return request(path, init, attempt + 1);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (body as any)?.message || (body as any)?.error || `HTTP ${res.status}`;
      throw new Error(`ZapsterAPI: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    }
    return body;
  }

  /** Enfileira para garantir uma chamada por vez, respeitando o limite de taxa. */
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  }

  return {
    sendMessage(input: SendInput): Promise<SendResult> {
      const body: Record<string, unknown> = {
        instance_id: cfg.instanceId || undefined,
        recipient: input.recipient,
        text: input.text,
        link_preview: !input.imageUrl,
      };
      if (input.imageUrl) body.media = { url: input.imageUrl, caption: input.text };
      return enqueue(async () => {
        const res = await request('/wa/messages', { method: 'POST', body: JSON.stringify(body) });
        return { messageId: String(res.message_id ?? '') };
      });
    },

    listInstances(): Promise<any> {
      return enqueue(() => request('/wa/instances', { method: 'GET' }));
    },
  };
}

export type ZapsterClient = ReturnType<typeof createZapsterClient>;
