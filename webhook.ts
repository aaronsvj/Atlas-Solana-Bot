import express from "express";
import crypto from "crypto";
import { createDashboardRouter } from "./dashboard-api";

const HELIUS_WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET ?? "";

export function startWebhookServer(
  processEvent: (event: any) => Promise<void>,
  connection: any,
  bot: any
) {

  const app = express();
  app.use(express.json());

  // ── Helius webhook ────────────────────────────────────────────────────
  app.post("/helius-webhook", async (req: any, res: any) => {

    if (HELIUS_WEBHOOK_SECRET) {
      const signature = (req.headers["authorization"] as string) ?? "";
      const body = JSON.stringify(req.body);
      const expected = crypto
        .createHmac("sha256", HELIUS_WEBHOOK_SECRET)
        .update(body)
        .digest("hex");
      if (signature !== expected) {
        console.warn("⚠️ Webhook signature mismatch — rejected");
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    const events = req.body;
    for (const event of events) {
      await processEvent(event);
    }
    res.sendStatus(200);
  });

  // ── Dashboard API ─────────────────────────────────────────────────────
  app.use("/api", createDashboardRouter(connection, bot));

  app.listen(3001, () => {
    console.log("Webhook server running on port 3001");
  });

}