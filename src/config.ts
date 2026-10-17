// Configuração lida de variáveis de ambiente. Nenhuma credencial fica em arquivo versionado.

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

export const config = {
  port: Number(env('PORT', '3000')),
  panelUser: env('PANEL_USER', 'admin'),
  panelPassword: env('PANEL_PASSWORD'),
  dbPath: env('DB_PATH', './data/disparador.db'),
  timezone: env('TZ', 'America/Sao_Paulo'),

  zapster: {
    baseUrl: env('ZAPSTER_BASE_URL', 'https://api.zapsterapi.com/v1'),
    token: env('ZAPSTER_TOKEN'),
    instanceId: env('ZAPSTER_INSTANCE_ID'),
    sendDelayMs: Number(env('SEND_DELAY_MS', '4000')),
    webhookSecret: env('ZAPSTER_WEBHOOK_SECRET'),
  },

  shopee: {
    endpoint: env('SHOPEE_ENDPOINT', 'https://open-api.affiliate.shopee.com.br/graphql'),
    appId: env('SHOPEE_APP_ID'),
    secret: env('SHOPEE_SECRET'),
  },

  mercadoLivre: {
    mattWord: env('ML_MATT_WORD'),
    mattTool: env('ML_MATT_TOOL'),
    accessToken: env('ML_ACCESS_TOKEN'),
  },
};

export type Config = typeof config;
