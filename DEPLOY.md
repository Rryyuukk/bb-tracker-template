# Production Deploy Checklist — BB Tracker + Dashboard

Deploy order matters: **add env vars first, then deploy.** Env vars only take
effect on builds created *after* they're added. If you deploy first, add vars,
you must redeploy.

---

## 1. Required Vercel environment variables

### Dashboard (`/dashboard`) — required for the dashboard to work
| Var | Required | Notes |
|---|---|---|
| `DASHBOARD_PASSWORD` | ✅ | Shared password the team uses to log in. |
| `SESSION_SECRET` | ✅ | Random 32+ byte hex string, signs the login cookie. See §2. |
| `POSTHOG_API_KEY` | ✅ | PostHog **Personal API key** (`phx_...`), with Query Read scope. NOT the public `phc_...` project key. |
| `POSTHOG_PROJECT_ID` | ✅ | Numeric project id (PostHog → Settings → Project). |
| `POSTHOG_API_HOST` | ✅ | API host: `https://us.posthog.com` (US cloud) or `https://eu.posthog.com` (EU cloud). NOT the `*.i.posthog.com` ingestion host. |

### Tracker / CAPI — required for event tracking itself (per product/market `<KEY>`)
| Var | Required | Notes |
|---|---|---|
| `TIKTOK_<KEY>_PIXEL_ID` | for TikTok | e.g. `TIKTOK_PRODUCT_1_US_PIXEL_ID` |
| `TIKTOK_<KEY>_ACCESS_TOKEN` | for TikTok | |
| `META_<KEY>_PIXEL_ID` | for Meta | optional if not running Meta CAPI |
| `META_<KEY>_ACCESS_TOKEN` | for Meta | |
| `META_<KEY>_TEST_CODE` | optional | test events only |
| `SHOPIFY_DOMAIN_MAPPING` | for Shopify | JSON: `{"my-store.myshopify.com":"product_1_us"}` |
| `SHOPIFY_<KEY>_WEBHOOK_SECRET` | for Shopify | webhook signing secret (HMAC fail-closed) |
| `PAGE_ID_MAPPING` | optional | JSON, maps `page_id` → `<KEY>` |
| `BRAND_<KEY>` / `CONTENT_PREFIX_<KEY>` / `CONTENT_CATEGORY_<KEY>` | optional | event metadata |

### Checkout Champ (`/api/checkout-champ`) — only if using Checkout Champ
| Var | Required | Notes |
|---|---|---|
| `CHECKOUT_CHAMP_WEBHOOK_SECRET` | ✅ | Shared token authenticating the postback (fail-closed). |
| `CHECKOUT_CHAMP_DEFAULT_KEY` | ✅* | Fallback pixel `<KEY>` (e.g. `product_1_us`). *Required unless every postback sends `pixel_key` or matches a campaign mapping. |
| `CHECKOUT_CHAMP_CAMPAIGN_MAPPING` | optional | JSON `{ "<campaignId>": "<KEY>" }` for multi-product CC accounts. |
| `POSTHOG_PROJECT_API_KEY` | for dashboard | PostHog **project write** key (`phc_...`) — needed so server purchases show on the dashboard. NOT the personal query key. |
| `POSTHOG_INGEST_HOST` | for dashboard | Ingestion host, e.g. `https://us.i.posthog.com` (NOT the `us.posthog.com` API host). |

> The dashboard works independently of the CAPI vars — it only needs the
> PostHog + dashboard vars above. But for real funnel data, the tracker must be
> live on your pages and mirroring events to PostHog. The **Purchase** funnel
> stage and purchase events in the feed require `POSTHOG_PROJECT_API_KEY` +
> `POSTHOG_INGEST_HOST` (server ingest) to be set.

---

## 2. Generate SESSION_SECRET

Any one of these:

```bash
# Node (cross-platform)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# OpenSSL (macOS/Linux/Git Bash)
openssl rand -hex 32

# PowerShell (Windows)
powershell -Command "[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')"
```

---

## 3. Add env vars to Vercel (production)

Interactive (prompts for each value, paste when asked):

```bash
vercel env add DASHBOARD_PASSWORD production
vercel env add SESSION_SECRET production
vercel env add POSTHOG_API_KEY production
vercel env add POSTHOG_PROJECT_ID production
vercel env add POSTHOG_API_HOST production
```

Non-interactive (pipe the value in — handy for scripting):

```bash
printf 'YOUR_STRONG_PASSWORD'                  | vercel env add DASHBOARD_PASSWORD production
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" | vercel env add SESSION_SECRET production
printf 'phx_your_personal_api_key'             | vercel env add POSTHOG_API_KEY production
printf '12345'                                 | vercel env add POSTHOG_PROJECT_ID production
printf 'https://us.posthog.com'                | vercel env add POSTHOG_API_HOST production
```

Verify what's set:

```bash
vercel env ls production
```

---

## 4. Deploy to production

```bash
vercel --prod
```

The command prints the production URL on success (e.g.
`https://bb-tracker-template.vercel.app`). Note it.

If you added/changed env vars after an earlier deploy, redeploy to pick them up:

```bash
vercel --prod --force
```

---

## 5. Test the deployed dashboard

Replace `APP` with your production URL.

Browser:
1. Open `https://APP/dashboard`
2. Log in with `DASHBOARD_PASSWORD`
3. Confirm the funnel, breakdowns, and **Live events** feed populate
   (feed refreshes every 10s).

CLI smoke test:

```bash
APP=https://bb-tracker-template.vercel.app

# page serves
curl -s -o /dev/null -w "dashboard=%{http_code}\n" $APP/dashboard

# gate blocks anonymous data access (expect 401)
curl -s -w " events_noauth=%{http_code}\n" $APP/api/dashboard/events?limit=1

# login -> cookie
curl -s -c c.txt -o /dev/null -X POST $APP/api/auth/login \
  -H "Content-Type: application/json" -d '{"password":"YOUR_PASSWORD"}'

# authed data (expect 200 with JSON; 503 = PostHog vars missing/wrong)
curl -s -b c.txt -w " stats=%{http_code}\n" "$APP/api/dashboard/stats?days=7"
rm -f c.txt
```

Expected: `dashboard=200`, `events_noauth=401`, `stats=200`.
- `stats=503` → PostHog env vars missing or wrong (check `POSTHOG_API_HOST` is
  the API host, and the key is a Personal API key with query access).
- `stats=200` but all zeros → tracker not yet live on pages, or PostHog project
  has no recent events.

---

## 6. Send to the team after deploy

Share securely (password manager / DM, not a public channel):

> **BB Tracker Dashboard**
> URL: https://APP/dashboard
> Password: `<DASHBOARD_PASSWORD>`
>
> - Use the **Range** dropdown (24h–90d) to change the window.
> - Funnel = Visits → Engaged → Started → CTA Clicked → Checkout (distinct sessions).
> - **Live events** refreshes every 10s.
> - The page is `noindex` and password-gated. Don't paste the link publicly.

To rotate access later: change `DASHBOARD_PASSWORD` (and ideally `SESSION_SECRET`
to force-expire existing sessions), then `vercel --prod --force`.

---

## 7. (If using Checkout Champ) Postback URL

After deploy, paste this into Checkout Champ (Campaign → Postbacks). Replace
`APP` and `SEU_TOKEN` (= `CHECKOUT_CHAMP_WEBHOOK_SECRET`). Method **GET**:

```
https://APP/api/checkout-champ?token=SEU_TOKEN&event=Purchase&order_id={orderId}&transaction_id={transactionId}&campaign_id={campaignId}&total={totalAmount}&currency={currencyCode}&product_id={productId}&product_name={productName}&quantity={quantity}&email={emailAddress}&phone={phoneNumber}&first_name={firstName}&last_name={lastName}&city={city}&state={state}&zip={postalCode}&country={country}&ip={ipAddress}&fbclid={fbclid}&fbp={fbp}&ttclid={ttclid}&bb_user_id={bb_user_id}
```

Test it (expect `ok` and a `meta_event_id`; `401` = bad token):
```bash
curl -s "https://APP/api/checkout-champ?token=SEU_TOKEN&order_id=test123&total=49.99&currency=USD&email=test@example.com&product_id=p1&quantity=1"
```
Pass `fbclid`/`fbp`/`ttclid`/`bb_user_id` through the checkout as CC custom
fields for good Meta/TikTok match quality.
