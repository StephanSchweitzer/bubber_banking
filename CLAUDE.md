# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo.

## ⚠️ This is a real, live service — not a demo

**Real bank accounts are already linked and this syncs real financial data into a
real Google Sheet.** The linked institutions are production Plaid items (credit
cards and bank accounts). Treat every run as production:

- `npm run sync` and `npm run snapshot` hit **production Plaid** and **write to the
  owner's real spreadsheet**. Do not run them casually to "see if it works" — a run
  mutates real data and consumes real Plaid API calls.
- Prefer verifying logic without side effects: `npm run typecheck`, or exercise the
  pure functions in `src/balances.ts` (`buildColumns`, `buildRow`, `periodKeys`)
  with mock data.
- If you must run a live command, say so first and get the owner's go-ahead.
- **Never** print, commit, or paste the contents of `tokens.json`, `.env`, or the
  service-account JSON — they hold access tokens and keys. All are gitignored; keep
  it that way.

## What it does

Pulls data from **Plaid** and syncs it into a **Google Sheet**. Polling only, no
webhooks — nothing needs to be publicly exposed.

Three entry points (all in `src/`, run via `tsx`):

- **`npm run link`** (`link.ts`) — interactive, local, once per bank. Serves a page
  that runs Plaid Link, exchanges the public token, and appends the item to
  `tokens.json`. Requests the `Transactions` + `Liabilities` products.
- **`npm run sync`** (`sync.ts`) — headless, cron-friendly. Incrementally pulls
  `/transactions/sync` per item into the **Transactions** tab, then runs a balance
  snapshot at the end (best-effort — a snapshot failure won't fail the sync).
- **`npm run snapshot`** (`snapshot.ts`) — headless. Records credit limits, amounts
  owed, payments due, and cash into the **Daily / Weekly / Monthly / Yearly** tabs.

## Architecture

| File | Responsibility |
| --- | --- |
| `config.ts` | Loads + validates env (`.env` via dotenv). Tab-name constants. Secrets live only in env. |
| `plaid.ts` | The single shared `PlaidApi` client. |
| `tokens.ts` | Read/write `tokens.json` (linked items + per-item sync cursor). Atomic writes. |
| `link.ts` | Mode 1: Plaid Link bootstrap server. |
| `sync.ts` | Mode 2: transaction sync orchestration, then `runSnapshot()`. |
| `sheets.ts` | `TransactionsSheet` — owns the **Transactions** tab (keyed upsert on `transaction_id`). |
| `balances.ts` | Fetches balances/liabilities from Plaid; shapes columns/rows/period keys. Pure, testable. |
| `snapshot-sheet.ts` | `SnapshotSheet` — generic period-keyed grid writer + color formatting for the balance tabs. |
| `snapshot.ts` | Balance-snapshot entry point; exports `runSnapshot()`. |

## Invariants — keep these true

- **The writer only touches its own tabs**: `Transactions` and the four balance tabs
  (`Daily`/`Weekly`/`Monthly`/`Yearly`). A human-edited **Budget** tab in the same
  spreadsheet must never be read or modified.
- **Idempotent / re-runnable**: transactions upsert keyed on `transaction_id`;
  balance rows upsert keyed on the period key (day / ISO week / month / year), so
  re-running within a period overwrites rather than duplicates.
- **Sync cursors** are persisted per item only after a successful drain, so a
  mid-run failure reprocesses safely on the next run.
- **One item failing is logged and skipped**; the rest of the run still completes.
  `npm run sync` exits non-zero if any item failed so cron/monitoring can alert.
- Balance snapshots are **lossless**: historical rows and columns for accounts that
  later disappear are preserved, not dropped.

## Balance snapshot layout

Per credit card (blue): `Owed`, `Limit`, `Due Date`, `Min Pmt`. Then bold credit
totals (dark blue): `Total Owed`, `Total Limit`, `Available`, `Total Min Pmt`. Then
each deposit account's `Balance` (green) and a bold `Cash Total`.

**Known limitation:** `Due Date` and `Min Pmt` come from `/liabilities/get`, which
needs the **Liabilities** product *and* cardholder consent on the item. Items linked
before Liabilities was added return `ADDITIONAL_CONSENT_REQUIRED` and those two
columns stay blank until the card is re-linked (`npm run link`). Limits and balances
come from `/accounts/balance/get` and always populate. Code degrades gracefully.

## Conventions

- TypeScript, run directly with `tsx` (no build step). `npm run typecheck` = `tsc --noEmit`.
- Node 18+ (developed on v22). Windows-friendly; deploys to a Linux droplet + cron.
- Secrets come from `.env` only (see `.env.example`). Nothing hardcoded.
- Match the existing style: small focused modules, thorough doc-comments explaining
  *why*, defensive error handling that degrades rather than crashes.
