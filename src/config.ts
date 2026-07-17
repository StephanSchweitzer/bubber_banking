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
