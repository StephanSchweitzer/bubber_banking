import { RemovedTransaction, Transaction } from "plaid";
import { plaidClient } from "./plaid";
import { readTokens, updateCursor, ItemToken } from "./tokens";
import { TransactionsSheet, SheetRow } from "./sheets";
import { runSnapshot } from "./snapshot";

/**
 * Mode 2 — headless sync. For every linked item, pull incremental changes from
 * Plaid /transactions/sync (using the stored cursor) and upsert them into the
 * Google Sheet. Idempotent and safe to re-run; a single item failing is logged
 * and skipped so the rest of the run still completes. Suitable for cron.
 */

/** Map a Plaid transaction to a sheet row, resolving the account name from a map. */
function toRow(
  txn: Transaction,
  accountNames: Map<string, string>,
  institution: string
): SheetRow {
  const category =
    txn.personal_finance_category?.primary ??
    (txn.category ? txn.category.join(" > ") : "");
  return [
    txn.transaction_id,
    txn.date,
    txn.name ?? "",
    txn.merchant_name ?? "",
    txn.amount,
    category,
    accountNames.get(txn.account_id) ?? txn.account_id,
    institution,
  ];
}

/** Fetch account_id -> "Account Name" for one item (sync payloads omit account names). */
async function loadAccountNames(
  accessToken: string
): Promise<Map<string, string>> {
  const res = await plaidClient.accountsGet({ access_token: accessToken });
  const map = new Map<string, string>();
  for (const acct of res.data.accounts) {
    map.set(acct.account_id, acct.name ?? acct.official_name ?? acct.account_id);
  }
  return map;
}

async function syncItem(item: ItemToken, sheet: TransactionsSheet): Promise<void> {
  const accountNames = await loadAccountNames(item.access_token);

  const added: Transaction[] = [];
  const modified: Transaction[] = [];
  const removed: RemovedTransaction[] = [];

  let cursor = item.cursor ?? undefined;
  let hasMore = true;

  // Drain all pages before touching the sheet, then persist the final cursor.
  // If anything throws mid-way the cursor isn't advanced, so the next run
  // reprocesses safely (upserts are idempotent).
  while (hasMore) {
    const res = await plaidClient.transactionsSync({
      access_token: item.access_token,
      cursor,
      count: 500,
    });
    const data = res.data;
    added.push(...data.added);
    modified.push(...data.modified);
    removed.push(...data.removed);
    cursor = data.next_cursor;
    hasMore = data.has_more;
  }

  const upserts: SheetRow[] = [...added, ...modified].map((t) =>
    toRow(t, accountNames, item.institution_name)
  );
  const removedIds = removed
    .map((r) => r.transaction_id)
    .filter((id): id is string => Boolean(id));

  await sheet.apply({ upserts, removedIds });

  if (cursor) {
    await updateCursor(item.item_id, cursor);
  }

  console.log(
    `  ${item.institution_name}: +${added.length} added, ` +
      `~${modified.length} modified, -${removed.length} removed`
  );
}

async function main(): Promise<void> {
  const tokens = await readTokens();
  if (tokens.length === 0) {
    console.log(
      "No linked institutions found (tokens.json is empty or missing). " +
        "Run `npm run link` first."
    );
    return;
  }

  console.log(`Syncing ${tokens.length} institution(s)...`);
  const sheet = new TransactionsSheet();
  await sheet.init();

  let failures = 0;
  for (const item of tokens) {
    try {
      await syncItem(item, sheet);
    } catch (err: unknown) {
      failures++;
      const detail =
        (err as any)?.response?.data ?? (err as Error)?.message ?? err;
      console.error(
        `  ${item.institution_name}: FAILED — skipping this item.`,
        detail
      );
    }
  }

  console.log(
    failures === 0
      ? "Transaction sync complete."
      : `Transaction sync complete with ${failures} item failure(s).`
  );

  // Record a balance snapshot too, so one cron entry keeps everything fresh.
  // Best-effort: a snapshot failure must not fail the transaction sync.
  try {
    await runSnapshot();
  } catch (err: unknown) {
    console.error(
      "Balance snapshot failed (transactions were still synced):",
      (err as any)?.response?.data ?? (err as Error)?.message ?? err
    );
  }

  // Non-zero exit on any failure so cron / monitoring can notice.
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
