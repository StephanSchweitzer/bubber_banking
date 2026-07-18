import { plaidClient } from "./plaid";
import { ItemToken } from "./tokens";
import { Column, SnapshotRow } from "./snapshot-sheet";

/**
 * Fetches current balances (and, where available, credit-card payment details)
 * from Plaid and shapes them into the columns/rows the snapshot tabs expect.
 *
 * Balances come from /accounts/balance/get (available on every item). Payment
 * due date + minimum payment come from /liabilities/get, which requires the
 * Liabilities product on the item — if it isn't enabled (e.g. an item linked
 * before we added the product) those cells stay blank instead of failing.
 */

export interface AccountSnapshot {
  label: string; // "American Express Platinum Card"
  kind: "credit" | "bank";
  balance: number | null; // credit: amount owed; bank: cash on hand
  limit: number | null; // credit limit (credit only)
  dueDate: string | null; // next payment due date, ISO (credit only)
  minPayment: number | null; // minimum payment (credit only)
}

interface CreditLiability {
  minimum_payment_amount?: number | null;
  next_payment_due_date?: string | null;
}

/** Pull balances for one item, degrading gracefully if liabilities aren't available. */
async function snapshotItem(item: ItemToken): Promise<AccountSnapshot[]> {
  const balRes = await plaidClient.accountsBalanceGet({
    access_token: item.access_token,
  });

  // Best-effort liabilities: keyed by account_id. Absent product => empty map.
  const liabByAccount = new Map<string, CreditLiability>();
  try {
    const liabRes = await plaidClient.liabilitiesGet({
      access_token: item.access_token,
    });
    for (const c of liabRes.data.liabilities?.credit ?? []) {
      if (c.account_id) liabByAccount.set(c.account_id, c);
    }
  } catch (err: unknown) {
    const detail = (err as any)?.response?.data?.error_code ?? "unavailable";
    console.log(
      `  ${item.institution_name}: liabilities not available (${detail}) — ` +
        `payment-due columns will be blank until the card is re-linked with the ` +
        `Liabilities product.`
    );
  }

  const out: AccountSnapshot[] = [];
  for (const acct of balRes.data.accounts) {
    const name = acct.name || acct.official_name || acct.mask || acct.account_id;
    const label = `${item.institution_name} ${name}`.trim();
    const bal = acct.balances;

    if (acct.type === "credit") {
      const liab = liabByAccount.get(acct.account_id);
      out.push({
        label,
        kind: "credit",
        balance: bal.current ?? null,
        limit: bal.limit ?? null,
        dueDate: liab?.next_payment_due_date ?? null,
        minPayment: liab?.minimum_payment_amount ?? null,
      });
    } else if (acct.type === "depository") {
      out.push({
        label,
        kind: "bank",
        balance: bal.available ?? bal.current ?? null,
        limit: null,
        dueDate: null,
        minPayment: null,
      });
    }
    // Loans / investments / other are ignored for this dashboard.
  }
  return out;
}

/** Fetch a full snapshot across every linked institution. */
export async function fetchSnapshot(
  tokens: ItemToken[]
): Promise<AccountSnapshot[]> {
  const all: AccountSnapshot[] = [];
  for (const item of tokens) {
    all.push(...(await snapshotItem(item)));
  }
  return all;
}

// --- Column / row shaping --------------------------------------------------

const CREDIT_TOTAL = {
  balance: "Credit Total Owed",
  limit: "Credit Total Limit",
  available: "Credit Available",
  minPayment: "Credit Total Min Pmt",
} as const;

const CASH_TOTAL = "Cash Total";

/** Per-card sub-column suffixes (kept short so headers stay readable). */
function creditCols(label: string): Column[] {
  return [
    { key: `${label} — Owed`, format: "currency", group: "credit" },
    { key: `${label} — Limit`, format: "currency", group: "credit" },
    { key: `${label} — Due Date`, format: "date", group: "credit" },
    { key: `${label} — Min Pmt`, format: "currency", group: "credit" },
  ];
}

/**
 * Build the ordered column list for a snapshot: period + timestamp, then each
 * credit card's group, the credit totals, then each bank account, then cash total.
 */
export function buildColumns(accounts: AccountSnapshot[]): Column[] {
  const credit = accounts
    .filter((a) => a.kind === "credit")
    .sort((a, b) => a.label.localeCompare(b.label));
  const bank = accounts
    .filter((a) => a.kind === "bank")
    .sort((a, b) => a.label.localeCompare(b.label));

  const cols: Column[] = [
    { key: "Period", format: "text", group: "period" },
    { key: "Last Updated", format: "text", group: "meta" },
  ];

  for (const c of credit) cols.push(...creditCols(c.label));

  cols.push(
    { key: CREDIT_TOTAL.balance, format: "currency", group: "creditTotal" },
    { key: CREDIT_TOTAL.limit, format: "currency", group: "creditTotal" },
    { key: CREDIT_TOTAL.available, format: "currency", group: "creditTotal" },
    { key: CREDIT_TOTAL.minPayment, format: "currency", group: "creditTotal" }
  );

  for (const b of bank) {
    cols.push({ key: `${b.label} — Balance`, format: "currency", group: "bank" });
  }
  cols.push({ key: CASH_TOTAL, format: "currency", group: "cash" });

  return cols;
}

/** Build the value row for a period from the current snapshot. */
export function buildRow(
  accounts: AccountSnapshot[],
  periodKey: string,
  takenAt: string
): SnapshotRow {
  const values: Record<string, string | number | null> = {
    "Last Updated": takenAt,
  };

  let totalOwed = 0;
  let totalLimit = 0;
  let totalMinPmt = 0;
  let cashTotal = 0;

  for (const a of accounts) {
    if (a.kind === "credit") {
      values[`${a.label} — Owed`] = a.balance;
      values[`${a.label} — Limit`] = a.limit;
      values[`${a.label} — Due Date`] = a.dueDate;
      values[`${a.label} — Min Pmt`] = a.minPayment;
      totalOwed += a.balance ?? 0;
      totalLimit += a.limit ?? 0;
      totalMinPmt += a.minPayment ?? 0;
    } else {
      values[`${a.label} — Balance`] = a.balance;
      cashTotal += a.balance ?? 0;
    }
  }

  values[CREDIT_TOTAL.balance] = round2(totalOwed);
  values[CREDIT_TOTAL.limit] = round2(totalLimit);
  values[CREDIT_TOTAL.available] = round2(totalLimit - totalOwed);
  values[CREDIT_TOTAL.minPayment] = round2(totalMinPmt);
  values[CASH_TOTAL] = round2(cashTotal);

  return { periodKey, values };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- Period keys -----------------------------------------------------------

export type Cadence = "daily" | "weekly" | "monthly" | "yearly";

/**
 * The period key a given moment belongs to, for one cadence. Two dates share a
 * key iff they fall in the same day / ISO week (Mon-start) / month / year — so
 * comparing keys is how the period views decide whether a transaction is "in"
 * the current window.
 */
export function periodKeyOf(date: Date, cadence: Cadence): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  switch (cadence) {
    case "daily":
      return `${y}-${m}-${d}`;
    case "weekly": {
      const [isoYear, isoWeek] = isoWeekOf(date);
      return `${isoYear}-W${String(isoWeek).padStart(2, "0")}`;
    }
    case "monthly":
      return `${y}-${m}`;
    case "yearly":
      return `${y}`;
  }
}

/** Period keys for all four cadences, derived from one moment. */
export function periodKeys(now: Date): Record<Cadence, string> {
  return {
    daily: periodKeyOf(now, "daily"),
    weekly: periodKeyOf(now, "weekly"),
    monthly: periodKeyOf(now, "monthly"),
    yearly: periodKeyOf(now, "yearly"),
  };
}

/** ISO-8601 week number and its week-year. */
function isoWeekOf(date: Date): [number, number] {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  );
  // Thursday of the current week decides the week-year.
  const day = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return [d.getUTCFullYear(), week];
}
