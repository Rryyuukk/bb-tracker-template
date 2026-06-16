# BB Tracker — Setup Details Form

Hi! To finish setting up your tracking dashboard, we need a few details from you.

**How to fill this in:**
- For each item below, paste your value on the line that says **Your value:**
- If you don't have something or it doesn't apply, just write **"don't have it"** or **"skip"**.
- Don't worry about the technical names in `CAPITALS` — those are just for our setup. Focus on the "Where to find it" notes.
- When you're done, save this file and send it back to us. (Keep it private — it contains access details.)

> **A quick note on "product key":** We use a short label for your product, like `product_1_us`. You'll see it repeated in a few places below — just keep it the same everywhere. If you only have one product, you can leave it as `product_1_us`.

---

## 1. Dashboard password

This is the password your team will type to open the dashboard.

**`DASHBOARD_PASSWORD`**
- What to paste: A password you choose (make it strong).
- Where to find it: You make it up.
- Your value: ______________________________

**`SESSION_SECRET`**
- What to paste: Nothing — leave blank, we'll generate this for you.
- Where to find it: We handle this on our side.
- Your value: *(leave blank)*

---

## 2. PostHog details

PostHog is the analytics tool that feeds the dashboard. If you don't have an account yet, create a free one at **posthog.com** and tell us — we can help.

**`POSTHOG_API_KEY`**
- What to paste: Your "Personal API key" (it starts with `phx_`).
- Where to find it: In PostHog, go to **Settings → Personal API keys → Create**, allow "Query Read", then copy it.
- Your value: ______________________________

**`POSTHOG_PROJECT_ID`**
- What to paste: Your project's ID number (just digits, like `12345`).
- Where to find it: In PostHog, go to **Settings → Project**. The number is shown there.
- Your value: ______________________________

**`POSTHOG_API_HOST`**
- What to paste: `https://us.posthog.com` if your account is US, or `https://eu.posthog.com` if EU.
- Where to find it: Look at the web address you use to log into PostHog (us or eu).
- Your value: ______________________________

**`POSTHOG_PROJECT_API_KEY`**
- What to paste: Your "Project API Key" (it starts with `phc_`). This is different from the one above.
- Where to find it: In PostHog, go to **Settings → Project → Project API Key**.
- Your value: ______________________________

**`POSTHOG_INGEST_HOST`**
- What to paste: `https://us.i.posthog.com` (US) or `https://eu.i.posthog.com` (EU). Note the extra "`.i.`".
- Where to find it: Same region as above (us or eu).
- Your value: ______________________________

---

## 3. Checkout Champ details

Only needed if you use Checkout Champ. If you don't, write "skip" and move on.

**`CHECKOUT_CHAMP_WEBHOOK_SECRET`**
- What to paste: A secret word or phrase you choose (like a second password).
- Where to find it: You make it up. We'll put it into Checkout Champ for you.
- Your value: ______________________________

**`CHECKOUT_CHAMP_DEFAULT_KEY`**
- What to paste: Your product key (e.g. `product_1_us`) — the same label used in sections 4 and 5.
- Where to find it: You decide it (keep it consistent).
- Your value: ______________________________

---

## 4. Meta Pixel / CAPI details

From **Meta Business → Events Manager → (your pixel) → Settings**.

**`META_PRODUCT_1_US_PIXEL_ID`**
- What to paste: Your Meta Pixel / Dataset ID (a long number).
- Where to find it: In Events Manager, it's shown at the top of your pixel.
- Your value: ______________________________

**`META_PRODUCT_1_US_ACCESS_TOKEN`**
- What to paste: Your Conversions API access token (a long code).
- Where to find it: Events Manager → your pixel → **Settings → Conversions API → Generate access token**.
- Your value: ______________________________

**`META_PRODUCT_1_US_TEST_CODE`**
- What to paste: A test code — optional, only for testing. Leave blank if unsure.
- Where to find it: Events Manager → **Test Events** tab.
- Your value: ______________________________

---

## 5. TikTok CAPI details

From **TikTok Ads Manager → Tools → Events → Web Events → (your pixel) → Manage → Events API**.

**`TIKTOK_PRODUCT_1_US_PIXEL_ID`**
- What to paste: Your TikTok Pixel ID.
- Where to find it: On the Web Events page for your pixel.
- Your value: ______________________________

**`TIKTOK_PRODUCT_1_US_ACCESS_TOKEN`**
- What to paste: Your TikTok Events API access token (a long code).
- Where to find it: Under your pixel's **Events API** setup.
- Your value: ______________________________

---

## 6. Shopify details (optional)

Only needed if you sell through Shopify. If not, write "skip".

**`SHOPIFY_DOMAIN_MAPPING`**
- What to paste: Your Shopify store address — just tell us the `.myshopify.com` address and your product key, e.g. "mystore.myshopify.com = product_1_us". We'll format it.
- Where to find it: In your Shopify admin, it's your store's `*.myshopify.com` web address.
- Your value: ______________________________

**`SHOPIFY_PRODUCT_1_US_WEBHOOK_SECRET`**
- What to paste: The webhook "signing secret" (a code Shopify shows you).
- Where to find it: Shopify → **Settings → Notifications → Webhooks**. After you (or we) add an "Order creation" webhook, copy the signing secret it displays.
- Your value: ______________________________

---

✅ That's everything. Save the file and send it back. If any item was confusing, just leave it blank and we'll sort it out together.
