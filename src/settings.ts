import type { Config } from './config.ts';
import type { Repo } from './db.ts';

// Chaves das integrações que podem ser cadastradas pelo painel (aba Configurações).
// Ficam no banco e sobrescrevem as variáveis de ambiente. Os clientes leem o objeto
// config a cada chamada, então a mudança vale na hora, sem reiniciar.

interface SettingDef {
  label: string;
  secret: boolean;
  apply: (config: Config, value: string) => void;
}

export const SETTINGS: Record<string, SettingDef> = {
  ZAPSTER_TOKEN: { label: 'Token da ZapsterAPI', secret: true, apply: (c, v) => (c.zapster.token = v) },
  ZAPSTER_INSTANCE_ID: { label: 'ID da instância Zapster', secret: false, apply: (c, v) => (c.zapster.instanceId = v) },
  SHOPEE_APP_ID: { label: 'AppId da Shopee', secret: false, apply: (c, v) => (c.shopee.appId = v) },
  SHOPEE_SECRET: { label: 'Secret da Shopee', secret: true, apply: (c, v) => (c.shopee.secret = v) },
  ML_MATT_WORD: { label: 'Etiqueta Mercado Livre (matt_word ou matt:USUARIO:TOOLID)', secret: false, apply: (c, v) => (c.mercadoLivre.mattWord = v) },
  ML_MATT_TOOL: { label: 'matt_tool do Mercado Livre', secret: false, apply: (c, v) => (c.mercadoLivre.mattTool = v) },
  ML_ACCESS_TOKEN: { label: 'Token OAuth do Mercado Livre (opcional)', secret: true, apply: (c, v) => (c.mercadoLivre.accessToken = v) },
  SEND_DELAY_MS: {
    label: 'Pausa entre grupos (ms)',
    secret: false,
    apply: (c, v) => (c.zapster.sendDelayMs = Number(v) || c.zapster.sendDelayMs),
  },
};

function currentValue(config: Config, key: string): string {
  const map: Record<string, unknown> = {
    ZAPSTER_TOKEN: config.zapster.token,
    ZAPSTER_INSTANCE_ID: config.zapster.instanceId,
    SHOPEE_APP_ID: config.shopee.appId,
    SHOPEE_SECRET: config.shopee.secret,
    ML_MATT_WORD: config.mercadoLivre.mattWord,
    ML_MATT_TOOL: config.mercadoLivre.mattTool,
    ML_ACCESS_TOKEN: config.mercadoLivre.accessToken,
    SEND_DELAY_MS: config.zapster.sendDelayMs,
  };
  return String(map[key] ?? '');
}

export function loadSettings(repo: Repo, config: Config) {
  for (const [key, value] of Object.entries(repo.getSettings())) {
    if (SETTINGS[key] && value) SETTINGS[key].apply(config, value);
  }
}

export function saveSettings(repo: Repo, config: Config, values: Record<string, string>) {
  for (const [key, raw] of Object.entries(values)) {
    const def = SETTINGS[key];
    const value = raw?.trim();
    if (!def || !value) continue; // campo vazio mantém o valor atual
    repo.setSetting(key, value);
    def.apply(config, value);
  }
}

/** Lista para o painel: segredos aparecem só mascarados. */
export function describeSettings(config: Config) {
  return Object.entries(SETTINGS).map(([key, def]) => {
    const v = currentValue(config, key);
    return {
      key,
      label: def.label,
      secret: def.secret,
      configured: !!v,
      value: def.secret ? (v ? `••••${v.slice(-4)}` : '') : v,
    };
  });
}
