import * as path from "path";
import express from "express";
import {
  CountryCode,
  Products,
} from "plaid";
import { plaidClient } from "./plaid";
import { config } from "./config";
import { addToken } from "./tokens";

/**
 * Mode 1 — interactive bootstrap (run locally, once per bank).
 * Serves a single static page that runs Plaid Link for the Transactions product.
 * On success it exchanges the public_token for an access_token and appends the
 * new item to tokens.json without clobbering institutions already linked.
 */

const app = express();
app.use(express.json());

const publicDir = path.join(__dirname, "..", "public");
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "link.html")));
app.use(express.static(publicDir));

// Create a Link token for the browser to initialize Plaid Link.
app.post("/api/create_link_token", async (_req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: "bubber-banking-local-user" },
      client_name: "Bubber Banking",
      // Transactions powers the ledger; Liabilities powers the credit-card
      // payment-due / minimum-payment columns on the balance snapshot tabs.
      products: [Products.Transactions, Products.Liabilities],
      country_codes: [CountryCode.Us],
      language: "en",
    });
    res.json({ link_token: response.data.link_token });
  } catch (err: unknown) {
    const detail = (err as any)?.response?.data ?? (err as Error).message;
    console.error("create_link_token failed:", detail);
    res.status(500).json({ error: "create_link_token failed", detail });
  }
});

// Exchange the public_token and persist the item.
app.post("/api/exchange_public_token", async (req, res) => {
  try {
    const { public_token, institution_name } = req.body ?? {};
    if (!public_token) {
      return res.status(400).json({ error: "missing public_token" });
    }
    const exchange = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = exchange.data;

    await addToken({
      item_id,
      access_token,
      institution_name: institution_name || "Unknown institution",
    });

    console.log(
      `Linked "${institution_name || "Unknown institution"}" (item ${item_id}). ` +
        `Saved to tokens.json.`
    );
    res.json({ ok: true, item_id, institution_name });
  } catch (err: unknown) {
    const detail = (err as any)?.response?.data ?? (err as Error).message;
    console.error("exchange_public_token failed:", detail);
    res.status(500).json({ error: "exchange_public_token failed", detail });
  }
});

app.listen(config.linkPort, () => {
  console.log(
    `\nPlaid Link bootstrap running (env: ${config.plaid.env}).\n` +
      `Open http://localhost:${config.linkPort} in your browser to link a bank.\n` +
      `Re-run this and link again to add more institutions. Ctrl+C to stop.\n`
  );
});
