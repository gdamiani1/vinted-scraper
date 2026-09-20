# Handover: vinted-scraper

**Written 2026-09-20.** Project root: `~/ARC store/vinted-scraper`. Built in a single day
(first DB row 14:20, last 19:14). This file is the state of play for whoever picks it up next,
including a future me.

---

## 1. What it is

A dependency-free Node scraper and buying assistant for Vinted. It searches any Vinted market,
pulls item pages and seller profiles, scores listings for resale potential, and alerts on new
matches. Full usage is in `README.md`; that file is accurate and current, so read it before
changing anything.

The pipeline that matters is `hunt`:

1. Search every tier-1 and tier-2 brand in `rules.json`, newest first.
2. Drop packaging listings (empty boxes, dust bags) and anything under `luxuryPriceFloorEur`.
3. **Text triage:** one model call per 40 listings, a fraction of a cent, estimating resale and
   computing `potential = (est resale - price) / price`.
4. **Photo check:** the top `--ai-max` candidates get every photo sent to a vision model, which
   returns condition, authenticity risk with the specific features it checked, completeness,
   stock-photo detection, red flags and a resale range.
5. **Buy score 0-100** from `src/rules.js`: margin, sellability (brand tier x category x size),
   and confidence, where high authenticity risk is a hard zero.

## 2. Where it actually stands

| Measure | Value |
|---|---|
| Listings in `vinted.db` | 14,749 |
| Distinct brands seen | 194 |
| Sent to the vision model | 398 |
| Buy score at or above 50 | 20 (after shipping was added to cost) |
| Buy score at or above 70 | 4 |
| Approximate cost of those 398 analyses | $0.68 |
| Tests | 53 pass, 0 fail |
| Items bought | 0 |
| Items resold | 0 |
| Resale estimates checked against a real sale | 0 |

**The last three rows are the whole problem.** Every euro figure in the database is a model's
guess. Nothing has been validated against money changing hands.

Quality of the verdicts is genuinely good. Sample, item 9711532409, The Row heels at 100 EUR:
the model read the gold insole stamp, the embossed sole logo, size and "Made in Italy" text,
judged the silhouette against authentic pairs, graded sole and heel wear, estimated resale at
150 to 250 EUR, and raised its own red flag that the seller's "minimal signs of wear" claim
contradicted the photos. Confidence 0.95, cost $0.0017.

## 3. Verified facts, do not re-derive

- Node v25.9.0. Tests pass with `npm test`.
- **Not a git repository.** A day's work and a 34 MB database with no version control. Fixing
  this is step 0 for anyone touching the code.
- `.env` holds `OPENROUTER_API_KEY` only. Default model `qwen/qwen3.8-flash`.
- **Use `/usr/bin/python3` for any Python.** The ActiveState `python3` on PATH segfaults.
- `recheck` already exists and is the paper-trading validator: it re-visits strong buys and
  records whether they went sold, reserved, removed or are still available. `watch` runs it
  every 3600s by default. This does not need building, only running.
- `rescore` recomputes buy scores from stored verdicts with no model calls, so rule changes are
  free to test against the 398 verdicts already on disk.
- Verdicts are cached per item and model in SQLite. Re-runs and the dashboard cost nothing.

## 4. Open decisions, unresolved

**a. Resale finder vs personal shopping: resolved by design (2026-09-20 19:20).**
`mySizes` in `rules.json` never touches scoring. It only drives the dashboard "My size" toggle and
the `--my-size` CLI flag (men's/unisex pieces in the owner's sizes). The buy score stays
market-based, so the two uses are two views of one score. Do not merge them.

**b. The 60 EUR luxury floor defines the hunting ground.**
It drops obvious fakes, which also parks every candidate in the 60 to 150 EUR band for brands
retailing 800 to 3000 EUR. That is exactly where competent counterfeits live. The floor is a
reasonable choice, but the fake rate in that band is currently unknown and is the single
largest unmeasured variable in the model.

**c. Location filter: deliberate, and shipping is now in the cost (2026-09-20 19:20).**
The luxury searches carry `near: false` on purpose (a 50 km radius would starve them); the local
searches (Nike, Levi's) do use the Zagreb radius. `hunt` only filters by location with `--near`.
The buy score now includes the item page's buyer shipping price in the all-in cost
(`src/rules.js`), which took the strong-buy count from 23 to 20 and the summed estimated margin
from ~2,160 to ~1,940 EUR. Returns and cross-border disputes are still not priced in.

**d. Telegram is not configured.** Token and chat id are both empty, so alerts are macOS only.
The value of this tool is speed, and good buys disappear within hours. Alerts that only fire
when the laptop is open waste most of the edge.

## 5. Next steps, in order

1. **`git init` and commit.** Add `vinted.db*`, `.env`, `hunt-results.json` to `.gitignore`.
2. **Run `vinted watch --config vinted.config.json` and leave it running for a week.**
   This is free validation and needs no capital. `recheck` will record how fast items vanish.
   Then compare disappearance speed by score band. If 70-plus picks go within hours while
   low scorers sit for days, other resellers are confirming the scoring works.
3. **Set up Telegram** (BotFather, then `telegram.token` and `telegram.chatId`) so alerts reach
   a phone.
4. **Buy five, around 400 EUR total.** Spread across brands, and deliberately include one that
   is probably fake. Sell all five. Record real purchase price, real sale price, days to sell
   and fees paid. That single cycle converts the model from guesswork to measurement and
   produces the fake-rate number that decides whether this is a business.
5. **Add outcome columns to `items`** for actual bought and sold prices, then use `rescore` to
   recalibrate the rules against measured results rather than estimates.
6. Only after the above: decide between flipping and selling the tool. See section 6.

## 6. Business model, unresolved

**Flipping** is not passive. It is buying, receiving, photographing, listing, shipping and
handling disputes. Margin looks like 30 to 80 EUR per successful flip, bought with hours and
capital.

**Selling the tool to resellers** is closer to passive and has a customer who computes payback
after one flip. Twenty subscribers at 25 EUR a month is 500 EUR. Two blockers to settle first:
distributing a scraper commercially is a different legal posture from personal use, and
DataDome escalates against tools rather than individuals.

## 6b. Added 2026-09-20 evening: embeddings, search, sell-through

- Local CLIP embeddings (`src/embed.js`, `src/enrich.js`) label every listing with category, style,
  colour, material and gender; semantic search and "Similar" in the dashboard; `vinted embed`.
- Nightly broad recheck (02:30) of recent luxury listings feeds `vinted stats` (`src/stats.js`):
  sell-through by segment. This is stage 1 of trend detection; forecasting needs 6-8 weeks of rows.
- Services are installed (`deploy/install-services.sh`): watcher, dashboard on 3211, daily hunt 07:30.
- Known label biases to revisit after a week of data: style prompts are still coarse; check the
  confusion between black/navy and leather/patent on a labelled sample.

## 7. Risks to keep visible

- **Counterfeits.** The core risk of the entire thesis, currently unquantified. Step 4 measures it.
- **Vinted terms of service and DataDome.** The default 1.2s delay is deliberate. Raising volume
  or distributing the tool changes the risk profile sharply.
- **Croatian obrt scope.** Regular buying and reselling of goods is trgovina, which is not the
  same registered activity as web design on the obrtnica, and this revenue counts toward the
  pausal threshold. There is no accountant on GD Vergada, so this needs a call to Porezna
  before any volume, not after.
