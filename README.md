# Disparador de Ofertas (Shopee + Mercado Livre → WhatsApp)

Painel web para montar ofertas com link de afiliado da Shopee e do Mercado Livre e disparar para grupos de WhatsApp pela [ZapsterAPI](https://developer.zapsterapi.com), na hora ou agendado.

## Como funciona

```
 Shopee Affiliate API ─┐                       ┌─> Disparo manual (agora)
 (busca + link curto)  ├─> Ofertas (SQLite) ───┤
 Link do Mercado Livre ┘   + modelo de msg     └─> Agendador (uma vez / recorrente)
 (etiqueta matt_*)                                        │
                                                          ▼
                                        ZapsterAPI  POST /v1/wa/messages
                                        recipient = "group:<id>"  →  grupos do WhatsApp
```

| Parte | Arquivo | O que faz |
|---|---|---|
| Shopee | `src/providers/shopee.ts` | GraphQL `productOfferV2` (busca produtos com comissão) e `generateShortLink`. Assinatura `SHA256(AppId+Timestamp+Payload+Secret)`. |
| Mercado Livre | `src/providers/mercadolivre.ts` | Gera link de afiliado anexando `matt_word`/`matt_tool`, ou usa link pronto do painel (`mercadolivre.com/sec/...`). Lê título/preço/foto da API pública quando possível. |
| ZapsterAPI | `src/zapster.ts` | Envio de texto ou imagem com legenda, fila de 1 chamada por vez (limite de 3 req/s) e nova tentativa em 429. |
| Disparo | `src/dispatcher.ts` | Envia para cada grupo com pausa (`SEND_DELAY_MS`) e grava histórico. |
| Ofertas automáticas | `src/autoOffers.ts` | Agendamento que busca na Shopee por palavra-chave, escolhe o melhor produto ainda não enviado nos últimos 7 dias (com comissão mínima opcional) e dispara. |
| Agendador | `src/scheduler.ts` | Campanhas "uma vez" (data/hora) e "recorrentes" (cron, fuso `TZ`). Recorrentes enviam a próxima oferta da lista em rodízio. |
| API + painel | `src/app.ts`, `public/index.html` | Rotas REST e painel em uma página. |

Stack: Node.js 22.18+ rodando TypeScript direto (sem build), Fastify, SQLite embutido do Node (`node:sqlite`), node-cron, zod.

## Rodando

```bash
cp .env.example .env     # preencha os tokens
npm install
npm start                # http://localhost:3000
npm test                 # testes unitários
```

## Hospedagem (Railway)

1. Crie um projeto no Railway a partir deste repositório do GitHub (ele usa o `Dockerfile`).
2. Adicione um **Volume** montado em `/data`, para o banco não se perder a cada deploy.
3. Em Variables, cadastre só `PANEL_PASSWORD` (a senha do painel). Sem ela, o painel fica bloqueado.
4. Em Settings > Networking, gere um domínio. Esse é o link do painel.
5. Abra o painel e cadastre as chaves da Zapster, da Shopee e do Mercado Livre na aba **Configurações**.

As chaves também podem vir de variáveis de ambiente (veja `.env.example`); o que for salvo no painel tem prioridade.

## O que você precisa ter

1. **ZapsterAPI**: uma instância conectada ao seu WhatsApp (QR code) e um token em app.zapsterapi.com/tokens. Preencha `ZAPSTER_TOKEN` e `ZAPSTER_INSTANCE_ID`.
2. **Shopee**: acesso à Open API no painel de afiliados (affiliate.shopee.com.br). Preencha `SHOPEE_APP_ID` e `SHOPEE_SECRET`.
3. **Mercado Livre**: cadastro no programa de afiliados. Gere um link no "Gerador de link", veja os valores de `matt_word` e `matt_tool` na URL final e preencha `ML_MATT_WORD`/`ML_MATT_TOOL` (ou `ML_MATT_WORD=matt:USUARIO:TOOLID`).

## Grupos

A ZapsterAPI não documenta uma rota para listar grupos. Há duas formas de cadastrar:
- **Manual**: aba Grupos, informando o ID (`120363...@g.us` ou `group:120363...`).
- **Automática**: configure o webhook da instância na Zapster para `https://SEU_HOST/webhooks/zapster?secret=SEU_SEGREDO`. Quando chegar uma mensagem num grupo, ele aparece na lista.

## Limitações conhecidas

- **Mercado Livre não tem API pública para gerar link de afiliado.** O link é montado com a sua etiqueta (`matt_word`/`matt_tool`); confira no painel do ML se as vendas estão sendo atribuídas. Se preferir, cole direto o link curto gerado no painel.
- A API `api.mercadolibre.com/items` pode exigir token OAuth; sem ele, preencha título e preço à mão ao importar.
- O formato exato de envio de imagem com legenda na Zapster (`media.url` + `media.caption`) segue a especificação OpenAPI, mas precisa ser confirmado com a conta real no primeiro envio.
- Disparos em massa podem levar o número a ser bloqueado pelo WhatsApp. Mantenha `SEND_DELAY_MS` alto e poucos grupos por campanha.

## Segurança

- Credenciais só em `.env` (fora do git). Defina `PANEL_PASSWORD` antes de expor o painel na internet.
- O webhook aceita `ZAPSTER_WEBHOOK_SECRET` via `?secret=`.
