import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { Connection, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import crypto from "crypto";

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), "db.json");
const DASHBOARD_API_KEY = process.env.DASHBOARD_API_KEY ?? "";
const FEE_ACCUMULATOR_PUBKEY = process.env.FEE_ACCUMULATOR_PUBKEY ?? "69NC25VwwYhx51wkJYCo2umbjRv89ftwiFjyN6H1gMp6";
const FEE_ACCUMULATOR_SECRET = process.env.FEE_ACCUMULATOR_SECRET ?? "";

function loadDB() {
  try {
    if (!fs.existsSync(DB_PATH)) return { users: {} };
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.users ? parsed : { users: {} };
  } catch { return { users: {} }; }
}

function saveDB(db: any) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

function requireDashboardKey(req: Request, res: Response, next: Function) {
  if (!DASHBOARD_API_KEY) {
    res.status(500).json({ error: "DASHBOARD_API_KEY not configured on bot" });
    return;
  }
  const key = req.headers["x-dashboard-key"];
  if (key !== DASHBOARD_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export function createDashboardRouter(connection: Connection, bot: any): Router {
  const router = Router();

  router.use(requireDashboardKey);

  router.get("/stats", (req: Request, res: Response) => {
    try {
      const db = loadDB();
      const users = Object.values(db.users) as any[];
      const now = Date.now();
      const oneDayAgo = now - 24 * 60 * 60 * 1000;
      const newToday = users.filter(u => new Date(u.createdAt).getTime() > oneDayAgo).length;
      const copytradeCount = users.reduce((acc, u) => acc + (u.copytradeWallets?.length ?? 0), 0);
      const positionsCount = users.reduce((acc, u) => acc + (u.positions?.length ?? 0), 0);
      const recentUsers = users
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 20)
        .map(u => ({
          userId: u.userId,
          createdAt: u.createdAt,
          walletCount: u.wallets?.length ?? 0,
          copytradeCount: u.copytradeWallets?.length ?? 0,
          referralCode: u.referralCode,
        }));
      res.json({ userCount: users.length, newToday, copytradeCount, positionsCount, recentUsers });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get("/users", (req: Request, res: Response) => {
    try {
      const db = loadDB();
      const users = Object.values(db.users) as any[];
      const safe = users.map(u => ({
        userId: u.userId,
        createdAt: u.createdAt,
        referralCode: u.referralCode,
        referredBy: u.referredBy,
        referrals: u.referrals,
        wallets: (u.wallets ?? []).map((w: any) => ({ id: w.id, name: w.name, pubkey: w.pubkey, isDefault: w.isDefault, isManual: w.isManual, createdAt: w.createdAt })),
        copytradeWallets: (u.copytradeWallets ?? []).map((w: any) => ({ id: w.id, pubkey: w.pubkey, enabled: w.enabled, createdAt: w.createdAt })),
        positions: u.positions ?? [],
        sellLimits: u.sellLimits ?? [],
        global: u.global,
        buy: u.buy,
        sell: u.sell,
      }));
      res.json(safe);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get("/blacklist", (req: Request, res: Response) => {
    try {
      const db = loadDB() as any;
      res.json({ blacklist: db.tokenBlacklist ?? [] });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  router.post("/blacklist", (req: Request, res: Response) => {
    try {
      const { action, mint } = req.body;
      if (!mint || !action) { res.status(400).json({ error: "action and mint required" }); return; }
      const db = loadDB() as any;
      if (!db.tokenBlacklist) db.tokenBlacklist = [];
      if (action === "add") {
        if (!db.tokenBlacklist.includes(mint)) db.tokenBlacklist.push(mint);
      } else if (action === "remove") {
        db.tokenBlacklist = db.tokenBlacklist.filter((m: string) => m !== mint);
      } else { res.status(400).json({ error: "action must be add or remove" }); return; }
      saveDB(db);
      res.json({ success: true, blacklist: db.tokenBlacklist });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  router.post("/broadcast", async (req: Request, res: Response) => {
    try {
      const { message } = req.body;
      if (!message) { res.status(400).json({ error: "message required" }); return; }
      const db = loadDB();
      const userIds = Object.keys(db.users).map(Number);
      let success = 0, failed = 0;
      for (const uid of userIds) {
        try {
          await bot.telegram.sendMessage(uid, `📢 *Message from Atlas*\n\n${message}`, { parse_mode: "Markdown" });
          success++;
        } catch { failed++; }
        await new Promise(r => setTimeout(r, 50));
      }
      res.json({ success: true, sent: success, failed });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get("/fees", async (req: Request, res: Response) => {
    try {
      const lamports = await connection.getBalance(new PublicKey(FEE_ACCUMULATOR_PUBKEY));
      res.json({ balance: lamports / LAMPORTS_PER_SOL, address: FEE_ACCUMULATOR_PUBKEY });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  router.post("/fees/withdraw", async (req: Request, res: Response) => {
    try {
      const { toAddress, amount } = req.body;
      if (!toAddress || !amount) { res.status(400).json({ error: "toAddress and amount required" }); return; }
      try { new PublicKey(toAddress); } catch { res.status(400).json({ error: "Invalid Solana address" }); return; }
      if (!FEE_ACCUMULATOR_SECRET) { res.status(500).json({ error: "Fee keypair not configured" }); return; }
      const { Keypair, sendAndConfirmTransaction } = await import("@solana/web3.js");
      const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(FEE_ACCUMULATOR_SECRET)));
      const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(toAddress), lamports }));
      const sig = await sendAndConfirmTransaction(connection, tx, [kp], { commitment: "confirmed" });
      res.json({ success: true, signature: sig });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/partners
  router.get("/partners", (req: Request, res: Response) => {
    try {
      const db = loadDB() as any;
      const partnerIds: number[] = db.partners ?? [];
      const partners = partnerIds.map(id => {
        const u = db.users[String(id)] as any;
        if (!u) return null;
        const totalReferrals = Object.values(db.users).filter((x: any) => x.referredBy === u.referralCode).length;
        return {
          userId: id,
          referralCode: u.referralCode ?? "",
          lifetimeSolEarned: u.referrals?.lifetimeSolEarned ?? 0,
          totalReferrals,
        };
      }).filter(Boolean);
      res.json({ partners });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/partners  body: { action: "add"|"remove", userId: number }
  router.post("/partners", (req: Request, res: Response) => {
    try {
      const { action, userId } = req.body;
      if (!userId || !action) { res.status(400).json({ error: "action and userId required" }); return; }
      const db = loadDB() as any;
      if (!db.partners) db.partners = [];
      if (action === "add") {
        if (!db.users[String(userId)]) { res.status(404).json({ error: "User not found" }); return; }
        if (!db.partners.includes(userId)) db.partners.push(userId);
      } else if (action === "remove") {
        db.partners = db.partners.filter((id: number) => id !== userId);
      } else { res.status(400).json({ error: "action must be add or remove" }); return; }
      saveDB(db);
      res.json({ success: true, partners: db.partners });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  return router;
}