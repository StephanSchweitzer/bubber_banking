import { AccountSnapshot } from "./balances";
import { Cadence, periodKeyOf } from "./balances";

/**
 * Pure shaping for the period tabs (Daily / Weekly / Monthly / Yearly).
 *
 * Given the raw transaction ledger, the human-set budget targets, and the
 * current account balances, this builds a `PeriodView`: a small, presentation-
 * agnostic model of exactly what one tab should show for the *current* period —
 * an overview strip, a budget-by-category block, and one transaction section per
 * card/account. `period-sheet.ts` turns that model into cells and colours.
 *
 * Nothing here touches Plaid or Sheets, so it can be exercised with mock data
 * (see `npm run typecheck` and the scratch render script).
 *
 * Sign convention: the ledger stores *display-signed* amounts — money out is
 * negative, money in is positive (see `toRow` in sync.ts). So "spent" sums the
 * magnitude of negative amounts, and income is the positive ones.
 */

// --- Inputs ----------------------------------------------------------------

/** One transaction as read back from the Transactions tab. */
export interface LedgerTxn {
  date: string; // "YYYY-MM-DD"
  name: string;
  merchant: string;
  amount: number; // display-signed: - = money out, + = money in
  category: string; // humanized, e.g. "Food and drink"
  account: string; // account name (grouping key together with institution)
  institution: string;
}

/** A human-set monthly budget target for one category. */
export interface BudgetTarget {
  category: string;
  monthly: number;
}

// --- Output model ----------------------------------------------------------

export type Tone = "good" | "bad" | "neutral";

export interface OverviewStat {
  label: string;
  value: number;
  tone: Tone;
  /**
   * When set, the period sheet renders this stat as a *live* formula (referencing
   * the Budget tab / the tab's own budget block) instead of a baked-in number, so
   * it tracks Budget-tab edits and new transactions without waiting for a sync.
   * `value` remains the render-time snapshot (a fallback and the source of `tone`).
   */
  live?: "spent" | "leftToSpend" | "unallocated" | "projected" | "safeToday";
}

export interface BudgetLine {
  category: string;
  /** Target prorated to this cadence; null if the user hasn't set one. */
  target: number | null;
  spent: number;
  /** target - spent; null when there's no target. */
  left: number | null;
  /** spent / target, clamped to [0, 1] for the bar; null when no target. */
  fill: number | null;
  /** True when spending exceeded the (existing) target. */
  over: boolean;
}

export interface TxnLine {
  date: string;
  name: string;
  merchant: string;
  amount: number; // display-signed
  category: string;
}

export interface AccountSection {
  title: string; // "Amex Platinum"
  kind: "credit" | "bank";
  facts: string; // "Owed $1,940 · Limit $20,000 · Due Aug 5 · Min $40"
  txns: TxnLine[];
}

export interface PeriodView {
  title: string; // "Month — July 2026"
  cadence: Cadence;
  periodKey: string;
  subtitle: string; // reset hint + last-updated
  overview: OverviewStat[];
  budget: BudgetLine[];
  sections: AccountSection[];
  /** True if any budget target is set — drives whether budget columns show. */
  hasBudgets: boolean;
}

// --- Category helpers ------------------------------------------------------

/** "FOOD_AND_DRINK" -> "Food and drink". Idempotent for already-nice strings. */
export function humanizeCategory(raw: string): string {
  if (!raw) return "Uncategorized";
  // Plaid personal_finance_category primaries are SCREAMING_SNAKE. Legacy
  // hierarchical categories arrive as "A > B > C"; keep the leaf, tidy it.
  const leaf = raw.includes(">") ? raw.split(">").pop()!.trim() : raw;
  if (!/[A-Z_]/.test(leaf) || leaf.includes(" ")) return leaf; // already humanized
  const words = leaf.toLowerCase().split("_").filter(Boolean);
  if (words.length === 0) return "Uncategorized";
  return words[0][0].toUpperCase() + words[0].slice(1) + (words.length > 1 ? " " + words.slice(1).join(" ") : "");
}

/**
 * Whether a category's outflows count as "spending" for budgets. Transfers and
 * loan/credit-card payments move money between the owner's own accounts, so
 * counting them would double-count real spend — exclude them from the totals
 * (they still appear in the per-account transaction lists).
 */
export function isSpendCategory(category: string): boolean {
  const c = category.toLowerCase();
  if (c.startsWith("transfer")) return false;
  if (c.includes("loan payment")) return false;
  if (c.includes("credit card payment")) return false;
  return true;
}

// --- Proration -------------------------------------------------------------

/** How much of a *monthly* target applies to one period of the given cadence. */
export function prorationFactor(cadence: Cadence, now: Date): number {
  switch (cadence) {
    case "daily":
      return 1 / daysInMonth(now);
    case "weekly":
      return 12 / 52; // a month is ~4.33 weeks
    case "monthly":
      return 1;
    case "yearly":
      return 12;
  }
}

function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/**
 * How far through the current period we are, in [0, 1] — used to project a
 * run-rate spend for the whole period ("at this pace you'll spend $X"). Daily is
 * treated as fully elapsed (a projection within one day isn't meaningful).
 */
export function elapsedFraction(cadence: Cadence, now: Date): number {
  switch (cadence) {
    case "daily":
      return 1;
    case "weekly": {
      const mondayZero = (now.getDay() + 6) % 7; // Mon=0 … Sun=6
      return (mondayZero + 1) / 7;
    }
    case "monthly":
      return now.getDate() / daysInMonth(now);
    case "yearly": {
      const start = new Date(now.getFullYear(), 0, 1);
      const dayOfYear = Math.floor((now.getTime() - start.getTime()) / 86_400_000) + 1;
      const leap =
        (now.getFullYear() % 4 === 0 && now.getFullYear() % 100 !== 0) ||
        now.getFullYear() % 400 === 0;
      return dayOfYear / (leap ? 366 : 365);
    }
  }
}

// --- Formatting helpers (for the fact strings only) ------------------------

function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(round2(n)).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

/** "2026-08-05" -> "Aug 5". Returns "" for blank/unparseable input. */
function shortDate(iso: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- The builder -----------------------------------------------------------

const CADENCE_TITLE: Record<Cadence, string> = {
  daily: "Day",
  weekly: "Week",
  monthly: "Month",
  yearly: "Year",
};

const CADENCE_RESET: Record<Cadence, string> = {
  daily: "resets each night",
  weekly: "resets Monday morning",
  monthly: "resets on the 1st",
  yearly: "resets Jan 1",
};

export interface BuildPeriodViewInput {
  cadence: Cadence;
  now: Date;
  txns: LedgerTxn[];
  accounts: AccountSnapshot[];
  budgets: BudgetTarget[];
  /** The human's total monthly budget pool, if set (drives "Unallocated"). */
  monthlyBudget?: number | null;
  /** Human-readable "last updated" stamp, e.g. "2026-07-17 09:14". */
  takenAt: string;
}

export function buildPeriodView(input: BuildPeriodViewInput): PeriodView {
  const { cadence, now, txns, accounts, budgets, monthlyBudget, takenAt } = input;
  const periodKey = periodKeyOf(now, cadence);

  // Transactions that fall in the current period for this cadence.
  const inPeriod = txns.filter(
    (t) => periodKeyOf(parseDate(t.date), cadence) === periodKey
  );

  // --- Budget-by-category -------------------------------------------------
  const factor = prorationFactor(cadence, now);
  const targetByCat = new Map<string, number>();
  for (const b of budgets) targetByCat.set(b.category, b.monthly);

  const spentByCat = new Map<string, number>();
  for (const t of inPeriod) {
    if (t.amount >= 0) continue; // inflow, not spend
    if (!isSpendCategory(t.category)) continue;
    const cat = t.category || "Uncategorized";
    spentByCat.set(cat, (spentByCat.get(cat) ?? 0) + -t.amount);
  }

  // Union of budgeted categories and categories actually spent in.
  const catNames = new Set<string>([...targetByCat.keys(), ...spentByCat.keys()]);
  const budget: BudgetLine[] = [...catNames]
    .sort((a, b) => a.localeCompare(b))
    .map((category) => {
      const monthly = targetByCat.get(category);
      const target = monthly != null ? round2(monthly * factor) : null;
      const spent = round2(spentByCat.get(category) ?? 0);
      const left = target != null ? round2(target - spent) : null;
      const fill = target != null && target > 0 ? Math.min(1, spent / target) : null;
      return { category, target, spent, left, fill, over: target != null && spent > target };
    });
  const hasBudgets = budget.some((b) => b.target != null);

  // --- Overview strip -----------------------------------------------------
  const cash = round2(sum(accounts.filter((a) => a.kind === "bank").map((a) => a.balance ?? 0)));
  const owed = round2(sum(accounts.filter((a) => a.kind === "credit").map((a) => a.balance ?? 0)));
  const limit = round2(sum(accounts.filter((a) => a.kind === "credit").map((a) => a.limit ?? 0)));
  const spentTotal = round2(sum([...spentByCat.values()]));

  const overview: OverviewStat[] = [
    { label: "Cash on hand", value: cash, tone: "neutral" },
    { label: "Total owed", value: owed, tone: owed > 0 ? "bad" : "neutral" },
    { label: "Available credit", value: round2(limit - owed), tone: "neutral" },
    { label: `Spent this ${CADENCE_TITLE[cadence].toLowerCase()}`, value: spentTotal, tone: "neutral", live: "spent" },
  ];
  const totalTarget = round2(sum(budget.map((b) => b.target ?? 0)));
  if (hasBudgets) {
    const leftToSpend = round2(totalTarget - spentTotal);
    overview.push({
      label: "Left to spend",
      value: leftToSpend,
      tone: leftToSpend < 0 ? "bad" : "good",
      live: "leftToSpend",
    });
  }
  // Pace / projection: at the current run-rate, what will the whole period total?
  // Flags overspend early (before "Left to spend" actually goes negative). Not on
  // daily — projecting within a single day isn't meaningful.
  if (hasBudgets && cadence !== "daily") {
    const elapsed = elapsedFraction(cadence, now);
    const projected = round2(elapsed > 0 ? spentTotal / elapsed : spentTotal);
    overview.push({
      label: `Projected ${CADENCE_TITLE[cadence].toLowerCase()}`,
      value: projected,
      tone: projected > totalTarget ? "bad" : "good",
      live: "projected",
    });
  }
  // "Safe to spend today" (daily only): the monthly pool minus month-to-date spend,
  // spread over the days left in the month — one per-day number that keeps you on
  // track. Uses the pool (Budget B1), not just what's been allocated to categories.
  if (cadence === "daily" && monthlyBudget != null) {
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    let monthSpent = 0;
    for (const t of txns) {
      if (t.amount >= 0 || !isSpendCategory(t.category)) continue;
      if (t.date.startsWith(monthKey)) monthSpent += -t.amount;
    }
    const daysLeft = daysInMonth(now) - now.getDate() + 1;
    const safe = round2(Math.max(0, (monthlyBudget - round2(monthSpent)) / daysLeft));
    overview.push({ label: "Safe to spend today", value: safe, tone: "good", live: "safeToday" });
  }
  // On the monthly view, surface how much of the monthly pool is still unassigned
  // to categories (the allocation model lives on the Budget tab). Monthly only —
  // the pool is a monthly figure, so prorating it onto other cadences would mislead.
  if (cadence === "monthly" && monthlyBudget != null) {
    const allocated = round2(sum(budgets.map((b) => b.monthly)));
    const unallocated = round2(monthlyBudget - allocated);
    overview.push({
      label: "Unallocated",
      value: unallocated,
      tone: unallocated < 0 ? "bad" : "neutral",
      live: "unallocated",
    });
  }

  // --- Per-account transaction sections -----------------------------------
  // Group the period's transactions by their composed account label so they can
  // be matched to the snapshot account that carries balance/limit facts.
  const txnsByLabel = new Map<string, LedgerTxn[]>();
  for (const t of inPeriod) {
    const label = `${t.institution} ${t.account}`.trim();
    if (!txnsByLabel.has(label)) txnsByLabel.set(label, []);
    txnsByLabel.get(label)!.push(t);
  }

  const sections: AccountSection[] = [];
  const usedLabels = new Set<string>();
  // Credit cards first, then bank accounts — matching the snapshot ordering.
  const ordered = [...accounts].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "credit" ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  for (const acct of ordered) {
    usedLabels.add(acct.label);
    sections.push({
      title: cleanTitle(acct.label),
      kind: acct.kind,
      facts: factsFor(acct),
      txns: toTxnLines(txnsByLabel.get(acct.label) ?? []),
    });
  }
  // Any period transactions whose account isn't in the snapshot (rare) still get
  // shown, so nothing silently disappears.
  for (const [label, group] of txnsByLabel) {
    if (usedLabels.has(label)) continue;
    sections.push({ title: cleanTitle(label), kind: "bank", facts: "", txns: toTxnLines(group) });
  }

  return {
    title: `${CADENCE_TITLE[cadence]} — ${periodLabel(now, cadence)}`,
    cadence,
    periodKey,
    subtitle: `${CADENCE_RESET[cadence]} · updated ${takenAt}`,
    overview,
    budget,
    sections,
    hasBudgets,
  };
}

// --- Section helpers -------------------------------------------------------

function factsFor(a: AccountSnapshot): string {
  if (a.kind === "bank") {
    return a.balance != null ? `Balance ${money(a.balance)}` : "";
  }
  const parts: string[] = [];
  if (a.balance != null) parts.push(`Owed ${money(a.balance)}`);
  if (a.limit != null) parts.push(`Limit ${money(a.limit)}`);
  if (a.dueDate) parts.push(`Due ${shortDate(a.dueDate)}`);
  if (a.minPayment != null) parts.push(`Min ${money(a.minPayment)}`);
  return parts.join(" · ");
}

function toTxnLines(txns: LedgerTxn[]): TxnLine[] {
  return [...txns]
    .sort((a, b) => b.date.localeCompare(a.date)) // newest first
    .map((t) => ({
      date: t.date,
      name: t.name,
      merchant: t.merchant,
      amount: t.amount,
      category: t.category,
    }));
}

/** Drop a leading institution prefix when it's already obvious, keep it readable. */
function cleanTitle(label: string): string {
  return label.trim();
}

function periodLabel(now: Date, cadence: Cadence): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  switch (cadence) {
    case "daily":
      return `${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
    case "weekly":
      return `of ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
    case "monthly":
      return `${months[now.getMonth()]} ${now.getFullYear()}`;
    case "yearly":
      return `${now.getFullYear()}`;
  }
}

/** Parse "YYYY-MM-DD" as a local date (avoids UTC off-by-one from `new Date(str)`). */
function parseDate(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return new Date(iso);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
