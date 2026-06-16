# bb-tracker · Template

Universal tracker server-side pra **TikTok CAPI + Meta CAPI + GA4 (via GTM)**.
Funciona com qualquer funil Vercel + qualquer Shopify.

## O que tu ganha

- ✅ **CAPI server-side** TikTok + Meta (em paralelo, mesmo evento)
- ✅ **Dedup automático** (`event_id` matcheia pixel browser ↔ CAPI server)
- ✅ **HMAC fail-closed** no webhook Shopify (sem secret = request rejeitada)
- ✅ **bb-tracker.js** client-side (45KB) com tracking de quiz, VSL, advertorial, landing
- ✅ **sendBeacon fallback** pra preservar eventos no unload
- ✅ **Multi-produto + multi-mercado** sem rebuild (tudo via env vars)
- ✅ **GTM + GA4** integrados (configuras teu ID, ele dispara sozinho)

## Setup em 5 minutos

```bash
git clone <este-repo>.git
cd bb-tracker-template
cp .env.example .env.local
# Edita .env.local com TEUS Pixel IDs + Access Tokens
vercel link
vercel --prod
```

Depois adiciona as envs no Vercel:
```bash
vercel env add TIKTOK_PRODUCT_1_US_PIXEL_ID
vercel env add TIKTOK_PRODUCT_1_US_ACCESS_TOKEN
vercel env add META_PRODUCT_1_US_PIXEL_ID
vercel env add META_PRODUCT_1_US_ACCESS_TOKEN
vercel env add SHOPIFY_PRODUCT_1_US_WEBHOOK_SECRET
vercel env add SHOPIFY_DOMAIN_MAPPING
```

## Como adicionar no teu funil

```html
<script>
  window.BB_TRACKER_CONFIG = {
    pageType: 'quiz',                  // 'quiz' | 'vsl' | 'advertorial' | 'landing'
    pageId: 'product_1_us',            // KEY no .env (TIKTOK_<KEY>_PIXEL_ID)
    gtmId: 'GTM-XXXXXXX',              // teu GTM container
    ga4MeasurementId: 'G-XXXXXXXXXX',  // teu GA4 measurement ID
    capiEndpoint: 'https://SEU-bb-tracker.vercel.app/api/capi/event'
  };
</script>
<script src="https://SEU-bb-tracker.vercel.app/bb-tracker.js" defer></script>
```

## Setup do Shopify

### 1. Bridge no theme.liquid
Antes de `</body>` no `layout/theme.liquid`, cola o BB TRACKER BRIDGE
(ver aula da mentoria). Esse snippet persiste `ttclid` / `fbclid` / `utm_*`
em `cart.attributes` pra atribuição funcionar entre funil e Shopify.

### 2. Webhook Order creation
- Shopify Admin → Settings → Notifications → Webhooks
- Event: **Order creation**
- URL: `https://SEU-bb-tracker.vercel.app/api/capi/shopify-purchase`
- Format: JSON
- Copia o **Signing Secret** → `SHOPIFY_<KEY>_WEBHOOK_SECRET` no Vercel
- Adiciona teu domínio em `SHOPIFY_DOMAIN_MAPPING` (JSON env var)

### 3. Custom Pixels (Customer Events)
- Shopify Admin → Settings → Customer Events → Add Custom Pixel
- 1 pixel pra TikTok (ttq nativo) + 1 pixel pra Meta (via fetch relay)
- Ver aula da mentoria pros snippets prontos

## Setup do Checkout Champ

Pra rastrear vendas/upsells/rebills do Checkout Champ (Meta + TikTok CAPI +
dashboard). Diferente do Shopify, Checkout Champ **não assina com HMAC** —
autentica via **token compartilhado** (`CHECKOUT_CHAMP_WEBHOOK_SECRET`).

### 1. Envs no Vercel
```bash
vercel env add CHECKOUT_CHAMP_WEBHOOK_SECRET        # token secreto (qualquer string forte)
vercel env add CHECKOUT_CHAMP_DEFAULT_KEY           # KEY padrão (ex: product_1_us)
# multi-produto (opcional):
vercel env add CHECKOUT_CHAMP_CAMPAIGN_MAPPING      # {"<campaignId>":"<KEY>"}
# pra aparecer no dashboard:
vercel env add POSTHOG_PROJECT_API_KEY              # project write key (phc_...)
vercel env add POSTHOG_INGEST_HOST                  # https://us.i.posthog.com
```

### 2. Postback no Checkout Champ
- Campaign → Postbacks/Integrations → adiciona um postback HTTP.
- Method **GET** (ou POST JSON).
- URL (troca o domínio e o token):
```
https://SEU-bb-tracker.vercel.app/api/checkout-champ?token=SEU_TOKEN&event=Purchase&order_id={orderId}&transaction_id={transactionId}&campaign_id={campaignId}&total={totalAmount}&currency={currencyCode}&product_id={productId}&product_name={productName}&quantity={quantity}&email={emailAddress}&phone={phoneNumber}&first_name={firstName}&last_name={lastName}&city={city}&state={state}&zip={postalCode}&country={country}&ip={ipAddress}&fbclid={fbclid}&fbp={fbp}&ttclid={ttclid}&bb_user_id={bb_user_id}`
```

### 3. Atribuição (importante)
Pra match de qualidade no Meta, passa `fbclid` / `fbp` / `ttclid` / `bb_user_id`
pelo checkout (custom fields do Checkout Champ) pra eles voltarem no postback.
Sem isso, o match cai pra email/telefone/IP só. O endpoint reconstrói o `fbc`
a partir do `fbclid` automaticamente.

### Tipos de evento
`event=Purchase` (default). Também aceita `upsell`, `rebill`/`recurring`
(enviados como `Purchase` com `action_source: system_generated`). `decline` /
`refund` são reconhecidos e ignorados (responde 200 sem disparar).

## Endpoints

| Endpoint | O que faz |
|---|---|
| `POST /api/capi/event` | Eventos do bb-tracker.js (browser) → CAPI TikTok+Meta |
| `POST /api/capi/meta-event` | Relay pro Meta CAPI (usado pelo Custom Pixel Shopify, fbq bloqueado no sandbox) |
| `POST /api/capi/shopify-purchase` | Webhook Shopify (HMAC SHA256 verification) → Purchase pra TikTok+Meta |
| `GET/POST /api/checkout-champ` | Postback Checkout Champ (token auth) → Purchase pra Meta+TikTok+PostHog |
| `GET /dashboard` | Dashboard público (login + funnel + eventos ao vivo) |
| `POST /api/auth/login` | Login do dashboard (password → cookie de sessão assinado) |
| `POST /api/auth/logout` | Logout do dashboard |
| `GET /api/dashboard/stats` | Stats agregadas (funnel, breakdowns, timeseries) — lê do PostHog |
| `GET /api/dashboard/events` | Feed de eventos recentes — lê do PostHog |

## Dashboard (`/dashboard`)

Dashboard Vercel público pra compartilhar com o time por link. Login por
**senha única** + **funnel** + **breakdowns** (evento / device / page_id) +
**feed de eventos ao vivo** (atualiza a cada 10s).

Fonte de dados: **PostHog**. O `bb-tracker.js` já espelha todo evento pro
PostHog no browser — o dashboard só lê via HogQL (Query API). Não precisa de
banco de dados.

### Setup

1. **PostHog** — cria uma *Personal API key* (Settings → Personal API keys) com
   scope de leitura de query, e pega o *Project ID* numérico.
2. **Envs no Vercel** (ou `.env.local`):
   ```bash
   vercel env add DASHBOARD_PASSWORD        # senha que tu compartilha
   vercel env add SESSION_SECRET            # string aleatória (assina o cookie)
   vercel env add POSTHOG_API_KEY           # personal API key (NÃO a phc_...)
   vercel env add POSTHOG_PROJECT_ID        # id numérico do projeto
   vercel env add POSTHOG_API_HOST          # https://us.posthog.com ou https://eu.posthog.com
   ```
   Gera o `SESSION_SECRET`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
3. Garante que o `BB_TRACKER_CONFIG` das tuas páginas tem o PostHog carregado
   (snippet padrão do PostHog no `<head>`), pro tracker conseguir espelhar.
4. Deploy (`vercel --prod`) e acessa `https://SEU-bb-tracker.vercel.app/dashboard`.

> **Atenção ao host do PostHog:** `POSTHOG_API_HOST` é o host de *API*
> (`us.posthog.com` / `eu.posthog.com`), **não** o de ingestão
> (`*.i.posthog.com`). Usar o host errado retorna erro de query no dashboard.

## Como funciona o roteamento

1. Mentorado seta `pageId: 'product_1_us'` no `BB_TRACKER_CONFIG`
2. Evento chega em `/api/capi/event` com `page_id: 'product_1_us'`
3. `pixelForPageId('product_1_us')` busca `TIKTOK_PRODUCT_1_US_PIXEL_ID` no env
4. Envia pro TikTok com aquele pixel — **zero código** pra adicionar produto novo

Pra adicionar produto: só adiciona env vars `TIKTOK_<NOME>_PIXEL_ID` + `<NOME>_ACCESS_TOKEN` e usa `pageId: '<nome>'`. Pronto.

## Security

- `.gitignore` protege `.env*` (nunca commita credenciais)
- HMAC fail-closed: webhook sem `SHOPIFY_<KEY>_WEBHOOK_SECRET` retorna 500 (não aceita request)
- Domínios Shopify desconhecidos retornam 400 (não aceita request)
- `event_id` determinístico previne double-counting (Purchase tracked 1x mesmo se browser + CAPI dispararem)

## Stack técnico

- Vercel Functions (Node.js, CommonJS)
- Zero dependências (`package.json` sem deps de produção)
- TikTok CAPI v1.3 (`business-api.tiktok.com`)
- Meta CAPI v21.0 (`graph.facebook.com`)
- Shopify Webhook HMAC SHA256

## Licença

MIT — use à vontade.
