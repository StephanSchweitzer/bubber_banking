# bubber-banking

Pulls bank transactions from **Plaid** and syncs them into a **Google Sheet**.
No webhooks — polling only, so nothing needs to be publicly exposed.

Modes:

- `npm run link` — interactive, run locally. Opens Plaid Link in your browser to
  connect a bank, then saves its access token to `tokens.json`. Run once per bank.
- `npm run sync` — headless, cron-friendly. Pulls incremental changes via Plaid
  `/transactions/sync` for every linked bank and upserts them into the sheet, then
  records a balance snapshot (see below).
- `npm run snapshot` — headless. Records current credit limits, payments due, and
  cash on hand as one row per period into the **Daily / Weekly / Monthly / Yearly**
  tabs. Runs automatically at the end of `npm run sync`, or standalone.

The writer only ever touches its own tabs — **Transactions** and the four balance
tabs. A human-edited **Budget** tab in the same spreadsheet is never read or modified.

## Balance snapshot tabs

Each `snapshot` (or `sync`) run reads live balances from Plaid and writes one row
per period into four tabs — **Daily**, **Weekly**, **Monthly**, **Yearly** — so each
builds a colour-coded time series you can chart:

- **Per credit card** (blue): *Owed*, *Limit*, *Due Date*, *Min Pmt* columns.
- **Credit totals** (dark blue, bold): *Total Owed*, *Total Limit*, *Available*,
  *Total Min Pmt* across all cards.
- **Bank / cash** (green, on the right): each deposit account's *Balance*, then a
  bold *Cash Total*.

The period key is the row's identity: the current day / ISO week / calendar month /
year is upserted, so re-running within a period overwrites that row with the latest
figures rather than duplicating. New columns appear automatically when you link
another account; history is never dropped.

> **Payment-due columns need the Liabilities product.** Credit *limit* and *owed*
> come from `/accounts/balance/get` and work on any linked item. The *Due Date* and
> *Min Pmt* columns come from `/liabilities/get`, which requires the **Liabilities**
> product. `npm run link` now requests it, so **cards linked before this feature must
> be re-linked once** for those two columns to fill in — until then they stay blank
> (the run still succeeds).

## Configuration

All secrets come from `.env` (loaded via dotenv) — nothing is hardcoded. Copy the
template and fill it in:

```
cp .env.example .env
```

| Variable | Meaning |
| --- | --- |
| `PLAID_CLIENT_ID` | Plaid client ID |
| `PLAID_SECRET` | Plaid secret for the chosen environment |
| `PLAID_ENV` | `sandbox` or `production` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to the service-account JSON key |
| `SHEET_ID` | Target spreadsheet ID (from its URL) |

**Share the sheet with the service account:** open the spreadsheet, click Share,
and give the service account's `client_email` (found in the JSON key) Editor access.

`.env`, the service-account JSON, and `tokens.json` are all gitignored.

## (a) Local setup on Windows

```powershell
node --version        # v18+ (developed on v22)
npm install
copy .env.example .env   # then edit .env with your values
```

Put the service-account JSON somewhere in the project and point
`GOOGLE_APPLICATION_CREDENTIALS` at it.

## (b) Linking banks

```powershell
npm run link
```

Open <http://localhost:4000>, click **Connect a bank**, and complete Plaid Link.
In **sandbox**, choose any institution and use credentials `user_good` /
`pass_good`. On success the item is appended to `tokens.json`. Link another bank
by repeating — existing tokens are preserved. Stop the server with `Ctrl+C` when
done.

## (c) Deploy to a Linux droplet & schedule with cron

```bash
# on the droplet
git clone <your-repo-url> bubber-banking
cd bubber-banking
npm install

# provide secrets (do NOT commit these)
nano .env                      # paste your values
# copy your service-account JSON up too, e.g. via scp

# lock down the secret files
chmod 600 .env service-account.json
```

`tokens.json` is created by `npm run link`. The easiest path is to link banks
locally and copy `tokens.json` up to the droplet (it holds access tokens, so
`chmod 600 tokens.json` too). Alternatively run `npm run link` over an SSH tunnel.

Schedule a daily sync with crontab (`crontab -e`):

```cron
# run at 03:00 every day; log output
0 3 * * * cd /home/youruser/bubber-banking && /usr/bin/npm run sync >> /home/youruser/bubber-banking/sync.log 2>&1
```

Use an absolute path to `npm` (`which npm`) since cron has a minimal environment.
`npm run sync` exits non-zero if any institution failed, so a monitor can alert.

## How it stays safe to re-run

- Rows are upserted keyed on `transaction_id`, so re-runs never duplicate.
- Sync cursors are persisted per item in `tokens.json` after each successful run.
- One bank failing is logged and skipped; the rest of the run still completes.
