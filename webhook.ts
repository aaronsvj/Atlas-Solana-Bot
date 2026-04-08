import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), "db.json");
const HELIUS_SECRET = process.env.HELIUS_WEBHOOK_SECRET ?? "";
const DASHBOARD_KEY = process.env.DASHBOARD_API_KEY ?? "";
const FEE_ACCUMULATOR_PUBKEY = process.env.FEE_ACCUMULATOR_PUBKEY ?? "69NC25VwwYhx51wkJYCo2umbjRv89ftwiFjyN6H1gMp6";
const HELIUS_API_KEY = process.env.HELIUS_API_KEY ?? "";
const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

function loadDB(): { users: Record<string, any> } {
  try {
    if (!fs.existsSync(DB_PATH)) return { users: {} };
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.users ? parsed : { users: {} };
  } catch {
    return { users: {} };
  }
}

function saveDB(db: { users: Record<string, any> }) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

function requireKey(req: any, res: any, next: any) {
  const key = req.headers["x-dashboard-key"];
  if (!DASHBOARD_KEY || key !== DASHBOARD_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

export function startWebhookServer(
  processEvent: (event: any) => Promise<void>,
  _connection?: any,
  _bot?: any
) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // ── Helius webhook ────────────────────────────────────────────
  app.post("/helius-webhook", async (req: any, res: any) => {
    if (HELIUS_SECRET) {
      const sig = req.headers["helius-signature"] ?? "";
      const expected = crypto
        .createHmac("sha256", HELIUS_SECRET)
        .update(JSON.stringify(req.body))
        .digest("hex");
      if (sig !== expected) return res.sendStatus(401);
    }
    const events = req.body;
    for (const event of events) {
      await processEvent(event);
    }
    res.sendStatus(200);
  });

  // ── Dashboard API ─────────────────────────────────────────────

  app.get("/api/stats", requireKey, (_req: any, res: any) => {
    const db = loadDB();
    const users = Object.values(db.users) as any[];
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const newToday = users.filter(u => u.createdAt && new Date(u.createdAt).getTime() >= todayStart.getTime()).length;
    const copytradeCount = users.filter(u => u.copytradeWallets?.length > 0).length;
    const positionsCount = users.reduce((sum: number, u: any) => sum + (u.positions?.length ?? 0), 0);
    const recentUsers = users
      .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
      .slice(0, 10)
      .map(u => ({
        userId: u.userId,
        createdAt: u.createdAt,
        walletCount: u.wallets?.length ?? 0,
        referralCode: u.referralCode,
      }));
    res.json({ userCount: users.length, newToday, copytradeCount, positionsCount, recentUsers });
  });

  app.get("/api/users", requireKey, (_req: any, res: any) => {
    const db = loadDB();
    const users = Object.values(db.users).map((u: any) => ({
      userId: u.userId,
      createdAt: u.createdAt,
      walletCount: u.wallets?.length ?? 0,
      copytradeCount: u.copytradeWallets?.length ?? 0,
      referralCode: u.referralCode,
      referredBy: u.referredBy,
      totalReferrals: u.referrals?.telegramReferrals ?? 0,
      lifetimeSolEarned: u.referrals?.lifetimeSolEarned ?? 0,
    }));
    res.json({ users });
  });

  app.get("/api/blacklist", requireKey, (_req: any, res: any) => {
    const db = loadDB();
    res.json({ blacklist: (db as any).blacklist ?? [] });
  });

  app.post("/api/blacklist", requireKey, (req: any, res: any) => {
    const { action, mint } = req.body ?? {};
    if (!mint) return res.status(400).json({ error: "mint required" });
    const db = loadDB() as any;
    if (!db.blacklist) db.blacklist = [];
    if (action === "add") {
      if (!db.blacklist.includes(mint)) db.blacklist.push(mint);
    } else if (action === "remove") {
      db.blacklist = db.blacklist.filter((m: string) => m !== mint);
    } else {
      return res.status(400).json({ error: "action must be add or remove" });
    }
    saveDB(db);
    res.json({ ok: true, blacklist: db.blacklist });
  });

  app.get("/api/fees", requireKey, async (_req: any, res: any) => {
    try {
      const { Connection, PublicKey, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
      const conn = new Connection(RPC_URL, "confirmed");
      const lamports = await conn.getBalance(new PublicKey(FEE_ACCUMULATOR_PUBKEY));
      res.json({ balance: lamports / LAMPORTS_PER_SOL, address: FEE_ACCUMULATOR_PUBKEY });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/fees/transactions", requireKey, async (_req: any, res: any) => {
    try {
      if (!HELIUS_API_KEY) return res.status(500).json({ error: "HELIUS_API_KEY not set" });
      const url = `https://api.helius.xyz/v0/addresses/${FEE_ACCUMULATOR_PUBKEY}/transactions?api-key=${HELIUS_API_KEY}&limit=50&type=TRANSFER`;
      const r = await fetch(url);
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      const txs: any[] = await r.json();
      const transactions = txs
        .filter(tx => {
          const native = tx.nativeTransfers ?? [];
          return native.some((t: any) => t.toUserAccount === FEE_ACCUMULATOR_PUBKEY);
        })
        .map(tx => {
          const native = (tx.nativeTransfers ?? []).find((t: any) => t.toUserAccount === FEE_ACCUMULATOR_PUBKEY);
          return {
            signature: tx.signature,
            timestamp: tx.timestamp,
            amount: (native?.amount ?? 0) / 1e9,
            from: native?.fromUserAccount ?? "",
          };
        });
      res.json({ transactions });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/broadcast", requireKey, async (req: any, res: any) => {
    const { message, bot: botInstance } = req.body ?? {};
    if (!message) return res.status(400).json({ error: "message required" });
    if (!_bot) return res.status(500).json({ error: "Bot not available" });
    const db = loadDB();
    const userIds = Object.keys(db.users).map(Number);
    let sent = 0, failed = 0;
    for (const uid of userIds) {
      try {
        await _bot.telegram.sendMessage(uid, message, { parse_mode: "Markdown" });
        sent++;
      } catch {
        failed++;
      }
    }
    res.json({ sent, failed });
  });

  app.get("/api/partners", requireKey, (_req: any, res: any) => {
    const db = loadDB() as any;
    const partners = (db.partners ?? []).map((p: any) => {
      const userId = typeof p === "number" ? p : p.userId;
      const u = db.users?.[String(userId)];
      return {
        userId,
        referralCode: u?.referralCode ?? p.referralCode ?? "",
        addedAt: p.addedAt ?? u?.createdAt ?? "",
        lifetimeSolEarned: u?.referrals?.lifetimeSolEarned ?? 0,
        totalReferrals: u?.referrals?.telegramReferrals ?? 0,
        referralRate: u?.referralRate ?? 20,
      };
    });
    res.json({ ok: true, partners });
  });

  app.post("/api/partners/rate", requireKey, (req: any, res: any) => {
    const { userId, rate } = req.body ?? {};
    if (!userId || rate == null) return res.status(400).json({ error: "userId and rate required" });
    const r = Number(rate);
    if (isNaN(r) || r < 1 || r > 100) return res.status(400).json({ error: "rate must be 1-100" });
    const db = loadDB() as any;
    if (!db.users) db.users = {};
    // Create minimal record if user hasn't started the bot yet
    if (!db.users[String(userId)]) {
      db.users[String(userId)] = { userId: Number(userId), referralRate: r };
    } else {
      db.users[String(userId)].referralRate = r;
    }
    saveDB(db);
    res.json({ ok: true });
  });

  app.post("/api/partners", requireKey, (req: any, res: any) => {
    const { action, userId } = req.body ?? {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    const db = loadDB() as any;
    if (!db.partners) db.partners = [];
    const id = Number(userId);
    if (action === "add") {
      if (!db.partners.find((p: any) => p.userId === id)) {
        const user = db.users?.[String(id)];
        db.partners.push({
          userId: id,
          referralCode: user?.referralCode ?? "",
          addedAt: new Date().toISOString(),
        });
      }
    } else if (action === "remove") {
      db.partners = db.partners.filter((p: any) => p.userId !== id);
    } else {
      return res.status(400).json({ error: "action must be add or remove" });
    }
    saveDB(db);
    res.json({ ok: true, partners: db.partners });
  });

  app.listen(3001, () => {
    console.log("Webhook + Dashboard API server running on port 3001");
  });
}
