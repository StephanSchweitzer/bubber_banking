import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { config } from "./config";

/**
 * A single Plaid API client, configured from env. Shared by both modes.
 */
export const plaidClient = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[config.plaid.env],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": config.plaid.clientId,
        "PLAID-SECRET": config.plaid.secret,
      },
    },
  })
);
