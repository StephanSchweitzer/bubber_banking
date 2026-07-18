# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo. **This file is
developer-facing** — the end-user manual lives in [GUIDE.md](GUIDE.md) and is also
auto-written into the sheet's **Instructions** tab each run (`instructions.ts`).
Don't put end-user how-to here.

## ⚠️ This is a real, live service — not a demo

**Real bank accounts are already linked and this syncs real financial data into a
real Google Sheet.** The linked institutions are production Plaid items (credit
cards and bank accounts). Treat every run as production:

- `npm run sync`, `npm run snapshot`, and `npm run periods` hit **production Plaid**
  and **write to the owner's real spreadsheet**. Do not run them casually to "see if
  it works" — a run mutates real data and consumes real Plaid API calls.
- Prefer verifying logic without side effects: `npm run typecheck`, or exercise the
  pure functions in `src/balances.ts` (`buildColumns`, `buildRow`, `periodKeys`) and
  `src/period-view.ts` (`buildPeriodView`, `humanizeCategory`, `prorationFactor`)
  with mock data.
- If you must run a live command, say so first and get the owner's go-ahead.
- **Never** print, commit, or paste the contents of `tokens.json`, `.env`, or the
  service-account JSON — they hold access tokens and keys. All are gitignored; keep
  it that way.

## What it does

Pulls data from **Plaid** and syncs it into a **Google Sheet**. Polling only, no
webhooks — nothing needs to be publicly exposed.

Four entry points (all in `src/`, run via `tsx`):

- **`npm run link`** (`link.ts`) — interactive, local, once per bank. Serves a page
  that runs Plaid Link, exchanges the public token, and appends the item to
  `tokens.json`. Requests the `Transactions` + `Liabilities` products.
- **`npm run sync`** (`sync.ts`) — headless, cron-friendly. Incrementally pulls
  `/transactions/sync` per item into the **Transactions** tab, then (best-effort,
  sharing one balance fetch) archives balances into **Balance History** and
  re-renders the period tabs. A rendering failure won't fail the transaction sync.
- **`npm run snapshot`** (`snapshot.ts`) — headless. Archives credit limits, amounts
  owed, payments due, and cash as one daily row in the hidden **Balance History** tab.
- **`npm run periods`** (`periods.ts`) — headless. Renders the current-period
  budgeting dashboards into the **Daily / Weekly / Monthly / Yearly** tabs.

Maintenance helper: **`npm run reset-cursor`** (`reset-cursor.ts`) clears every
item's sync cursor (local `tokens.json` only) so the next `npm run sync` re-pulls
full history and rewrites existing rows in place — used to normalize older rows to
the current shape (display-signed amounts, humanized categories).

## Architecture

| File | Responsibility |
| --- | --- |
| `config.ts` | Loads + validates env (`.env` via dotenv). Tab-name constants. Secrets live only in env. |
| `plaid.ts` | The single shared `PlaidApi` client. |
| `tokens.ts` | Read/write `tokens.json` (linked items + per-item sync cursor). Atomic writes. |
| `link.ts` | Mode 1: Plaid Link bootstrap server. |
| `sync.ts` | Mode 2: transaction sync, then shares one balance fetch with `runSnapshot()` + `renderPeriods()`. |
| `sheets.ts` | `TransactionsSheet` — owns the **Transactions** tab (keyed upsert on `transaction_id`; hides machinery cols, humanized categories, display-signed amounts). |
| `balances.ts` | Fetches balances/liabilities from Plaid; shapes columns/rows/period keys (`periodKeyOf`, `periodKeys`). Pure, testable. |
| `snapshot-sheet.ts` | `SnapshotSheet` — generic period-keyed grid writer + color formatting (used by Balance History). |
| `snapshot.ts` | Balance-history entry point; exports `runSnapshot()` → hidden **Balance History** tab. |
| `period-view.ts` | Pure shaping for the period tabs: `buildPeriodView` (overview / budget-by-category / per-account sections), `humanizeCategory`, `prorationFactor`, spend classification. |
| `period-sheet.ts` | `PeriodSheet` — renders a `PeriodView` into a tab (merged bands, budget bars, sign-aware currency). Clear+rewrite each run. |
| `budget.ts` | Owns the **Budget** tab allocation cockpit: installs the block, reads pool + targets, append-only seeds categories, and writes the live Spent/Left formulas. Never overwrites human cells (B1 or targets). |
| `instructions.ts` | Writes the user manual into the **Instructions** tab (code-owned, rewritten each run so it can't drift). |
| `periods.ts` | Mode 4: reads the ledger + budget + balances, renders the four period tabs, refreshes budget formulas, and writes the Instructions tab. Exports `renderPeriods()`. |

## Invariants — keep these true

- **The writer only touches its own tabs**: `Transactions`, the four period tabs
  (`Daily`/`Weekly`/`Monthly`/`Yearly`), the hidden `Balance History` tab, and the
  `Instructions` tab. On the **Budget** tab, columns A+B are human-owned (the sync
  may **read** targets and **append** new categories with a blank target, but must
  **never overwrite** B1 or a human-entered target); columns C+D+E are code-owned
  live formulas (Spent/Left/Suggested), safe to rewrite each run.
- **Idempotent / re-runnable**: transactions upsert keyed on `transaction_id`;
  Balance History rows upsert keyed on the day; the period tabs are fully
  cleared and re-rendered each run. Re-running never duplicates.
- **Sync cursors** are persisted per item only after a successful drain, so a
  mid-run failure reprocesses safely on the next run.
- **One item failing is logged and skipped**; the rest of the run still completes.
  `npm run sync` exits non-zero if any item failed so cron/monitoring can alert.
- Balance History is **lossless**: historical rows and columns for accounts that
  later disappear are preserved, not dropped.
- **Transactions is the source of truth.** The period tabs are derived *views*
  filtered from it — nothing is ever lost when a period "resets"; the window just
  moves. Views re-render each `sync`/`periods` run (not live at midnight), so a
  period rolls over on the first run after the boundary.

## Period-tab layout

Each period tab shows the **current** period for its cadence (today / this ISO week,
Mon-start / this month / this year), stacked in a fixed 5-column grid
(`Date` / `Name` / `Merchant` / `Amount` / `Category`):

1. **Title band** + reset hint / last-updated subtitle.
2. **Overview** strip: `Cash on hand`, `Total owed`, `Available credit`,
   `Spent this <period>`, and (when budgets exist) `Left to spend`. Weekly/monthly/
   yearly also show `Projected <period>` (run-rate = spent ÷ elapsed-fraction, bad
   tone if it exceeds total budget); the daily tab shows `Safe to spend today`
   (remaining monthly budget ÷ days left, referencing `Monthly!D6` for month spend);
   the monthly tab shows `Unallocated` (`=Budget!B3`). The strip wraps to a second
   label/value row past five stats.
3. **Budget by category**: `Category` / `Budget` / `Spent` / `Left` / bar. These
   four value cells are **live formulas**, not baked-in numbers, so they track
   Budget-tab edits and new transactions the instant they change — no sync needed.
   `Budget` is a `VLOOKUP` into `Budget!A5:B` (the human target) prorated per cadence
   (daily = ÷ days-in-month via `EOMONTH`, weekly = ×12/52, monthly = ×1, yearly =
   ×12); `Spent` is a period-scoped `SUMIFS` over the ledger (the current period is
   expressed purely in the formula — a `TODAY()` wildcard for day/month/year, a
   `WEEKDAY`-derived Mon–Sun text range for the week); `Left` = `Budget − Spent`; the
   bar is a `REPT` block glyph. Overspend colour comes from two live **conditional-
   format** rules on `Left`+bar: **orange** when over target, **red** when over by
   ≥30% (`OVER_RED_THRESHOLD`). The render clears prior conditional rules first so
   they don't accumulate. The overview `Spent this <period>` / `Left to spend` /
   `Unallocated` stats are likewise live (they reference the block / `Budget!B3`).
4. **Rollover** (monthly tab only): per budgeted category, `Banked YTD` =
   `target × MONTH(TODAY()) − spent-YTD` (red when negative). A YNAB-style carryover
   approximation — it assumes the *current* target held all year (we don't snapshot
   historical targets).
5. **Biggest this <period>**: the top ~5 outflows (static, data-driven) — a "where
   did it go?" strip.
6. **One section per account** — a coloured band (credit = blue, bank = green) with
   the account's facts stated once (`Owed / Limit / Due / Min`, or `Balance`), then
   that period's transactions.

**Sign convention:** the ledger stores display-signed amounts — money out negative,
money in positive. "Spent" sums outflow magnitudes and **excludes** transfers and
loan/credit-card payments (they'd double-count real spend) but still lists them per
account. Categories are humanized at write time (`FOOD_AND_DRINK` → `Food and drink`).

## Balance History layout (hidden tab)

Per credit card (blue): `Owed`, `Limit`, `Due Date`, `Min Pmt`. Then bold credit
totals (dark blue): `Total Owed`, `Total Limit`, `Available`, `Total Min Pmt`. Then
each deposit account's `Balance` (green) and a bold `Cash Total`. One row per day.

**Known limitation:** `Due Date` and `Min Pmt` come from `/liabilities/get`, which
needs the **Liabilities** product *and* cardholder consent on the item. Items linked
before Liabilities was added return `ADDITIONAL_CONSENT_REQUIRED` and those two
columns stay blank until the card is re-linked (`npm run link`). Limits and balances
come from `/accounts/balance/get` and always populate. Code degrades gracefully.

## Budget tab layout (human-owned allocation cockpit)

```
A1 Monthly budget | B1  <- you type your monthly pool
A2 Allocated      | B2  =SUM(B5:B)   (live)
A3 Unallocated    | B3  =B1-B2       (live)
A4 Category | B4 Budget | C4 Spent (this month) | D4 Left | E4 Suggested (3-mo avg)
A5 <category> | B5 <target> | C5 =SUMIFS(...) | D5 =B5-C5 | E5 =avg last 3 months
...
```

B2/B3 and C/D/E are **live formulas** — allocated, unallocated, spent, left, and the
suggested target all update the instant a number changes, no sync needed. C (Spent)
is a month-to-date `SUMIFS` over the ledger keyed on category + a
`TEXT(TODAY(),"yyyy-mm")&"*"` wildcard (ledger dates are ISO text, so no date-serial
math). E (Suggested) averages the last three complete months' spend (`EDATE` month
wildcards) as a non-destructive hint — it never writes B. The sync READS B1 +
targets (A5:B), APPENDS newly-seen categories (blank target), and rewrites C/D/E via
`writeBudgetFormulas`; it never writes B1 or a human target. `ensureBudgetTab`
installs/repairs the block idempotently and migrates an old two-column layout by
inserting three rows on top. Numeric-looking categories are never seeded (guards a
past column-shift bug).

## Conventions

- TypeScript, run directly with `tsx` (no build step). `npm run typecheck` = `tsc --noEmit`.
- Node 18+ (developed on v22). Windows-friendly; deploys to a Linux droplet + cron.
- Secrets come from `.env` only (see `.env.example`). Nothing hardcoded.
- Match the existing style: small focused modules, thorough doc-comments explaining
  *why*, defensive error handling that degrades rather than crashes.
