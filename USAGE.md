# BB Tracker — Como usar

## Instalação (copiar no `<head>` de qualquer página)

```html
<!-- BB Tracker Config (ANTES do script) -->
<script>
  window.BB_TRACKER_CONFIG = {
    pageType: 'quiz',                  // 'quiz' | 'vsl' | 'advertorial' | 'landing'
    pageId: 'product_1_us',            // KEY usada nas envs (TIKTOK_<KEY>_PIXEL_ID)
    gtmId: 'GTM-XXXXXXX',              // teu Google Tag Manager
    ga4MeasurementId: 'G-XXXXXXXXXX',  // teu GA4 Measurement ID
    capiEndpoint: 'https://SEU-bb-tracker.vercel.app/api/capi/event'
  };
</script>
<script src="https://SEU-bb-tracker.vercel.app/bb-tracker.js" defer></script>
```

## Eventos Automáticos (não precisa fazer nada)

- `utm_captured` — salva UTMs da URL
- `device_info` — mobile/desktop + resolução
- `returning_visitor` — visitante que já veio antes
- `scroll_depth` — 25%, 50%, 75%, 100%
- `time_on_page` — 30s, 60s, 120s, 300s
- `exit_intent` — mouse saiu / tab fechou
- `video_play` — deu play no vídeo
- `video_progress` — 25%, 50%, 75%, 100% do vídeo
- `video_complete` — assistiu tudo
- `cta_visible` — botão CTA apareceu na tela
- `drop_off` — saiu do quiz sem completar

## Eventos Manuais (chamar no código)

```javascript
// Quiz events
bbTrack('quiz_start', { slide: '101_Age' });
bbTrack('step_view', { slide: '102_Goals' });
bbTrack('answer_selected', { slide: '101_Age', value: '30-40' });
bbTrack('email_submitted', { email_captured: true });
bbTrack('cta_clicked', { slide: '112_SalesPage' });
bbTrack('quiz_complete');
window.bbMarkQuizComplete(); // marca que completou (evita drop_off)

// VSL/Landing events
bbTrack('cta_clicked', { cta_text: 'Comprar Agora', cta_url: '...' });
```

## Para CTAs serem auto-detectados, adicione:

```html
<a href="..." data-bb-cta>Comprar Agora</a>
<!-- ou use classes: .cta-button, .buy-button, .checkout-btn -->
```
