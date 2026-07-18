import "dotenv/config";

/**
 * Loads and validates configuration from environment variables (.env via dotenv).
 * Secrets never live in source — they come from .env only.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env and fill it in.`
    );
  }
  return value.trim();
}

export type PlaidEnvName = "sandbox" | "production";

function parsePlaidEnv(): PlaidEnvName {
  const env = required("PLAID_ENV").toLowerCase();
  if (env === "sandbox" || env === "production") {
    return env;
  }
  throw new Error(
    `PLAID_ENV must be "sandbox" or "production" (got "${env}"). ` +
      `The legacy "development" environment is not supported.`
  );
}

export const config = {
  plaid: {
    clientId: required("PLAID_CLIENT_ID"),
    secret: required("PLAID_SECRET"),
    env: parsePlaidEnv(),
  },
  google: {
    // Path to the service-account JSON key file.
    credentialsPath: required("GOOGLE_APPLICATION_CREDENTIALS"),
    sheetId: required("SHEET_ID"),
  },
  // Port for the local Plaid Link bootstrap server (mode 1).
  linkPort: Number(process.env.LINK_PORT ?? 4000),
} as const;

export const TRANSACTIONS_TAB = "Transactions";

/**
 * Period-view tabs. Each holds a laid-out budgeting dashboard for the *current*
 * period of its cadence (today / this ISO week / this month / this year): an
 * overview strip, budget-by-category, and per-account transaction sections. They
 * re-render every run and "reset" when the period rolls over.
 */
export const PERIOD_TABS = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
} as const;

/**
 * Hidden time-series tab. Records credit limits, amounts owed, payments due, and
 * cash on hand — one row per day — so the net-worth/owed trend is preserved even
 * though the cadence tabs now show current-period budgeting instead of history.
 */
export const BALANCE_HISTORY_TAB = "Balance History";

/**
 * Human-owned budgeting tab: column A = category, column B = monthly target.
 * The sync READS these targets and APPENDS newly-discovered categories with a
 * blank target, but NEVER overwrites a value a human has entered.
 */
export const BUDGET_TAB = "Budget";

/** Code-written user manual tab (kept in sync with the real layout each run). */
export const INSTRUCTIONS_TAB = "Instructions";
