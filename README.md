# vinted-scraper

A smart, dependency-free Vinted scraper for Node ≥ 22.13. Search with real filters, pull full item
details and seller profiles, score bargains, and run a watcher that alerts you (console, Discord/Slack
webhook, macOS notification) the moment a matching listing appears or drops in price.

Works with every Vinted market (`vinted.hr`, `.fr`, `.de`, `.com`, `.co.uk`, `.pl`, …).

## How it works (and why the old approaches broke)

Vinted's web app moved to Next.js App Router in 2025. The old `/api/v2/catalog/items` JSON endpoint
now returns 404. Listings are embedded in the page's React Server Components (RSC) payload instead.
This scraper:

1. Bootstraps an anonymous session by fetching the homepage (this sets `access_token_web`,
   `refresh_token_web` and DataDome cookies). Vinted sends some cookies twice in one response,
   so the jar keeps the last value and deletes emptied ones; without that you get the
   "Session refresh" page forever.
2. Requests `/catalog?…` with the `RSC: 1` header, which returns the flight payload
   (~5 MB instead of ~7 MB of HTML) and extracts the items store with a balanced-brace
   scanner, so it is robust to chunk ordering and unrelated layout changes. Full HTML is also
   accepted and unwrapped automatically.
3. Reads item pages the same way (attributes, description, seller, shipping, fees, flags) and uses
   the still-working JSON endpoints for brands (`/api/v2/brands`), categories
   (`/api/v2/item_upload/catalogs`) and seller profiles (`/api/v2/users/:id`).
4. Throttles requests (1.2 s ± jitter by default), retries with exponential back-off, and refreshes
   the session on 401/403/"Session refresh". Any search is capped by Vinted at 10 pages × 96 items.

Verified filter parameters: `search_text`, `order`, `price_from`, `price_to`, `currency`,
`brand_ids[]`, `catalog[]`, `size_ids[]`, `status_ids[]`, `color_ids[]`, `page`.

## Install

```bash
cd vinted-scraper
npm link        # optional: makes the `vinted` command available globally
```

Or run in place with `node bin/vinted.js …` (add `--no-warnings=ExperimentalWarning` to silence
Node's SQLite notice, or use `npm run vinted -- …`).

## CLI

```bash
# search with name-resolved filters (brand names → ids, conditions in any Vinted language)
vinted search "nike air max" --brand nike --max 40 --condition new --condition "very good" --order newest --pages 3

# cut noise with title filters, export to CSV
vinted search "air max 90" --brand nike --include "air ?max" --exclude "tee|jersey|majica" --format csv --out airmax.csv

# rank bargains: price vs. comparable median (same brand + condition), new-with-tags bonus, demand signal
vinted deals "levis 501" --brand "Levi's" --pages 3 --min-score 40 --db vinted.db

# everything about one listing, plus the seller profile
vinted item https://www.vinted.hr/items/10068081140-nike-air-max-lite-tenisice --seller

# only sellers within 50 km of Vienna (seller profiles + OpenStreetMap geocoding, both cached)
vinted search "nike air max" --domain at --near Wien --radius 50 --pages 3 --db vinted.db
vinted deals "air max 90" --domain at --near Wien --strict-location --min-score 40   # strict: drop sellers who hide their city

# local dashboard over everything in the database (cards, filters, deal scores, seller links)
vinted serve --db vinted.db --port 3210

# lookups
vinted brands levi
vinted catalogs tenisice        # category titles are in the market's language; ids work everywhere
vinted user 90402166

# watch saved searches; alerts on new listings and price drops
vinted init                     # writes vinted.config.json
vinted watch --config vinted.config.json --mac          # alerts: console, macOS, Discord/Slack webhook, Telegram
vinted watch "air max 90" --brand nike --max 60 --interval 90 --min-score 40
```

Output defaults to a table on a TTY and JSON otherwise; `--format json|ndjson|csv` and `--out file`
apply everywhere. `--db file.db` records results in SQLite so `--new-only` prints only unseen
listings and deal scoring can use price history as its baseline.

### AI buying assistant (luxury resale)

`--ai` turns the deal finder into a buyer's assistant. After the cheap filters, the best candidates get
their full item page fetched and are shown to a vision model with all photos, the description, the
seller's claims and the price. The model returns a strict JSON verdict: item line and model,
condition from the photos, authenticity risk with the concrete features it checked, completeness
(box, dust bag, receipt, card), stock-image detection, red flags, a resale range and a one-line summary.

That verdict feeds an explainable **buy score** (0-100) from `src/rules.js`:

- **margin**: resale estimate × (1 - your selling fee) - all-in cost (price + buyer protection + shipping)
- **sellability**: brand tier × category liquidity × size desirability (Chanel at XXXL scores near zero)
- **confidence**: authenticity risk × model confidence; high risk is a hard zero

All weights live in [src/rules.default.json](src/rules.default.json). Copy it to `rules.json` in the
working directory (or pass `--rules file`) and edit brand tiers, size tables, category weights and fees
to match what actually sells for you.

```bash
export OPENROUTER_API_KEY=sk-or-…            # default model qwen/qwen3.8-flash via OpenRouter
vinted analyze https://www.vinted.at/items/…   # one listing: verdict + buy score + token cost
vinted deals "chanel" --brand Chanel --pages 3 --ai --ai-max 20 --min-buy 50 --db vinted.db
vinted watch --config vinted.config.json --ai  # verdicts on new arrivals, Telegram at buy ≥ ai.minBuy
vinted hunt --tier all --pages 2 --ai-max 40   # sweep every brand in rules.json: text triage, then photo checks on the best
```

`hunt` is the wide net: it searches every tier-1 (and with `--tier all`, tier-2) brand newest-first, drops packaging and
sub-floor prices, sends the survivors to a **text-only triage** (one model call per 40 listings, a fraction of a cent)
that picks what is plausibly underpriced and estimates resale, then photo-checks the top `--ai-max` candidates with
four verdicts in flight at a time. Results land in the database and the dashboard.

Any OpenAI-compatible vision endpoint works: `--ai-model qwen/qwen3.8-max-0902` for a second opinion,
or `VISION_BASE_URL`/`VISION_API_KEY` for DashScope, Zhipu, Gemini's compatibility endpoint, or a local
server. Verdicts are cached per listing and model in SQLite, so re-runs and the dashboard are free.
The dashboard's "Best buys (AI)" sort and "Analyzed only" filter show verdicts on each card.

### Categorisation, search and sell-through (local embeddings)

Every listing's main photo is embedded with CLIP running locally through Transformers.js (no API, no
cost, ~30 ms per image on Apple silicon; models download once to `~/.cache/vinted-scraper/models`).
From the vector, zero-shot prompts assign a **category** (handbag, crossbody bag, sneakers, boots, puffer,
jeans, …), **style** (quiet luxury, streetwear, y2k, vintage, gorpcore, …), **colour**, **material** and
gender presentation, each blanked when the model is not confident. The watcher labels new arrivals every
cycle; `vinted embed` backfills, `vinted embed --relabel` recomputes labels after taxonomy edits in
`src/embed.js`.

The dashboard uses this for the **Find** box (semantic search: "black leather bag with gold chain",
"mens suede chelsea boots"), the category/style/colour/material filters, and a **Similar** button on
every card. The API exposes `/api/items?q=…`, `/api/similar?id=…`, `/api/taxonomy`.

**Sell-through.** The watcher re-visits strong buys hourly and, at 02:30, every luxury-tier listing seen
in the last 14 days (up to 1,000 a night), recording sold / reserved / removed. `vinted stats` turns
that into sell-through at 3, 7 and 14 days and median days-to-sell by tier, category, style, price band
and brand (also `/api/sellthrough`). Give it two to four weeks before reading trends into it.

### Jev (TypeSafe AI) for the decisions that don't need eyes

[Jev](https://typesafe.ai) answers typed questions about a block of state with calibrated probabilities
instead of prose: ~100 ms per call, $0.042 per million input tokens, output free, text only. With
`TYPESAFE_API_KEY` in `.env` the scraper uses it for the **text triage** (is this a real, resellable
product; packaging or replica wording; category; gender; resale band) in one call per listing, in
parallel, instead of the batched LLM triage, and applies its category/gender when the image model is
unsure. Photo verdicts stay with the vision model, which Jev cannot do. Without the key nothing changes.

### Location filter

Vinted has no distance filter of its own, so `--near` works after the fact: each listing's seller profile
is fetched once (cached 30 days in SQLite), the seller's country must match the reference place, and the
seller's city is geocoded via Nominatim (cached forever) and checked against the radius. Sellers who
hide their city are kept and marked "city hidden" unless `--strict-location` is set. Expect a thin
stream: only a few percent of EU-wide listings come from Austrian sellers, so use more `--pages`.

### Alerts

Console always. `--mac` for macOS notifications, `--webhook` for Discord, Slack or any JSON endpoint,
and Telegram for pushes to your phone: create a bot with @BotFather, send it one message, read your
chat id from `https://api.telegram.org/bot<token>/getUpdates`, then set `telegram.token` and
`telegram.chatId` in the config (or `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`). Telegram only fires
for listings whose deal score is at least `telegram.minScore` (default 60), so it stays quiet
until something is genuinely cheap.

Global flags: `--domain fr` (or `VINTED_DOMAIN`), `--cookie "…"` to reuse a logged-in browser
session (or `VINTED_COOKIE`), `--proxy http://user:pass@host:port`, `--delay 2000`, `-v`/`-q`.

### Watch config

```json
{
  "domain": "hr",
  "intervalSec": 120,
  "db": "vinted.db",
  "webhook": "https://discord.com/api/webhooks/…",
  "mac": true,
  "minScore": 0,
  "pages": 2,
  "near": "Wien", "radiusKm": 50, "strictLocation": false,
  "telegram": { "token": "", "chatId": "", "minScore": 60 },
  "ai": { "enabled": true, "model": "qwen/qwen3.8-flash", "maxPerRun": 30, "minBuy": 50, "allBrands": false },
  "rules": "rules.json",
  "searches": [
    { "name": "Nike Air Max under 40", "query": "nike air max", "brand": "Nike", "priceTo": 40,
      "condition": ["new", "very good"], "include": ["air ?max"], "exclude": ["tee|shirt|jersey"] },
    { "name": "Levis 501 W32", "query": "levis 501 w32", "category": "jeans", "priceTo": 25, "minScore": 30 }
  ]
}
```

The first pass only seeds the database (use `--notify-first-run` to alert on it too). Each search
keeps its own failure counter and backs off independently, so one broken search never stops the rest.

## Library

```js
import { VintedScraper, Store, scoreDeals, watch, createNotifier } from './vinted-scraper/src/index.js';

const v = new VintedScraper({ domain: 'hr' });

const { items, pagination } = await v.search(
  { query: 'nike air max', brand: 'nike', priceTo: 40, condition: ['new', 'very good'], order: 'newest', exclude: ['tee'] },
  { pages: 2, enrich: false, seller: false },
);

const detail = await v.item(items[0].id);      // description, attributes, seller, shipping, fees, flags
const seller = await v.user(items[0].sellerId); // feedback counts, item counts, last login, country

const ranked = scoreDeals(items, { sort: true });
console.log(ranked[0].deal); // { score, belowMedianPct, median, comparableCount, comparableKey, reasons[] }

// incremental scraping
const store = new Store('vinted.db');
const { newItems, priceDrops } = store.recordSeen('nike air max', items);
```

`v.searchPages(params, { pages, stopWhen })` is an async iterator for page-by-page processing;
`stopWhen: (item) => seenIds.has(item.id)` stops early when ordering by newest.

### Listing shape

```
id, title, url, price, currency, priceWithDiscount, serviceFee, totalPrice, brand, size,
condition, conditionId (6 new w/ tags · 1 new w/o tags · 2 very good · 3 good · 4 satisfactory),
favouriteCount, isPromoted, thumbnail, photos[] (full size), dominantColor, sellerId,
sellerIsBusiness, searchScore, contentSource
```

## Running it as a service on a Mac (free hosting)

Vinted's bot protection is far friendlier to a home IP than to a datacenter, so the cheapest reliable host
is the Mac itself. `deploy/` contains launchd definitions for three login services: the watcher (restarts
on crash), the dashboard on port 3210 bound to all interfaces on port 3211 with a password, and a daily `hunt` at 07:30.

```bash
bash deploy/install-services.sh          # install and start; logs in ~/Library/Logs/vinted/
bash deploy/install-services.sh uninstall
```

The dashboard password lives in `.env` as `DASHBOARD_PASSWORD` (any username).

**Permanent public address (Cloudflare named tunnel).** Free quick tunnels (`cloudflared tunnel --url`)
get revoked after a few hours. For a fixed address on a domain in your Cloudflare account:

```bash
cloudflared tunnel login                        # once; opens the browser, pick the domain
bash deploy/setup-tunnel.sh vinted.yourdomain.com
```

This creates the tunnel, points the hostname at the dashboard, and installs it as a login service
that reconnects on its own (`com.arcstore.vinted.tunnel`, logs in `~/Library/Logs/vinted/tunnel.log`). To reach it from a phone,
install Tailscale on the Mac and the phone, sign in with the same account, and open
`http://<mac-name>:3210`; nothing is exposed to the public internet.

## Tests

```bash
npm test
```

Parsers are tested against fixtures cut from real Vinted payloads (`test/fixtures/`), so a layout
change on Vinted's side shows up as a failing test rather than silent empty results.

## Being a good citizen

The default delay is deliberately slow. Vinted uses DataDome; hammering it earns a 403 for your IP.
If you see `[BLOCKED]`, raise `--delay`, use a residential proxy, or pass your browser cookies.
Scrape only what you need and respect Vinted's terms of service.
