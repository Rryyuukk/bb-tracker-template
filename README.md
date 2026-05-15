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

## Endpoints

| Endpoint | O que faz |
|---|---|
| `POST /api/capi/event` | Eventos do bb-tracker.js (browser) → CAPI TikTok+Meta |
| `POST /api/capi/meta-event` | Relay pro Meta CAPI (usado pelo Custom Pixel Shopify, fbq bloqueado no sandbox) |
| `POST /api/capi/shopify-purchase` | Webhook Shopify (HMAC SHA256 verification) → Purchase pra TikTok+Meta |

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
