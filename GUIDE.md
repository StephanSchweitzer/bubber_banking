# Using the budgeting spreadsheet

A plain-language guide to what each tab is for, where to type, and where to look.
The same manual is also written into the **Instructions** tab inside the sheet
itself (auto-generated each sync, so it never goes stale) — this file is the
maintainer copy.

> The sheet updates itself from the bank automatically. You only ever type in
> **one** place: the **Budget** tab.

## The Budget tab — the only place you type

This is your budget cockpit. It updates live as you type; nothing needs saving.

| Where | What to do |
| --- | --- |
| **Monthly budget** (top cell) | Type how much money you have to budget each month. |
| **Category rows** (Budget column) | Type how much of that pool to spend in each category. |

Everything else on this tab is calculated for you:

- **Allocated** — how much you've assigned to categories so far (`=SUM` of your Budget column).
- **Unallocated** — pool minus allocated; what's still free to assign. Turns red if you assign more than your pool.
- **Spent (this month)** — month-to-date spending in that category, pulled live from the Transactions ledger.
- **Left** — Budget minus Spent for that category. Red when overspent.

**Your typed numbers persist forever.** The sync only reads them and adds new
category rows it discovers — it never overwrites the Monthly budget cell or any
target you've entered. You retype only when you *want* to change something.

## Daily / Weekly / Monthly / Yearly — where you watch spending

Each tab shows one current period and resets on its own:

- **Daily** — today. **Weekly** — since Monday. **Monthly** — since the 1st. **Yearly** — since Jan 1.

Layout, top to bottom: an **overview** strip (cash, owed, available credit, spent,
and — on Monthly — what's left / unallocated), then **budget vs spending by
category**, then **one section per card/account** with that period's transactions
(Date, Name, Merchant, Amount, Category; money in is green, money out is red).

These refresh automatically on each sync. **Don't type in them** — they're
rebuilt every run, so any manual edit is overwritten.

## Transactions — the raw list

Every transaction, filled in automatically. Five visible columns (date, name,
merchant, amount, category). Nothing to edit.

## Tabs to leave alone

- **Balance History** (hidden) — a daily archive of balances/limits over time.
- The period tabs and Transactions — all machine-maintained.

## For the maintainer

- Edit your budget targets/pool anytime on the Budget tab; they survive syncs.
- Re-seeding: new categories appear automatically with a blank target.
- If figures ever look wrong after a structural change, see the recovery helpers
  in [CLAUDE.md](CLAUDE.md) (`npm run reset-transactions`, `npm run reset-cursor`).
