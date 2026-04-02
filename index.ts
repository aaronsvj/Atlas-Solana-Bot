import "dotenv/config";
import sharp from "sharp";
import { Telegraf, Markup } from "telegraf";
import { startWebhookServer } from "./webhook";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import bs58 from "bs58";

/* =========================
   ENV + SETUP
========================= */

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("❌ BOT_TOKEN missing in .env");
  process.exit(1);
}

const RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

const JUPITER_API_BASE = process.env.JUPITER_API_BASE || "https://api.jup.ag";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY;

if (!JUPITER_API_KEY) {
  console.error("❌ JUPITER_API_KEY missing in .env");
  process.exit(1);
}

const MASTER_KEY_BASE64 = process.env.MASTER_KEY_BASE64;
if (!MASTER_KEY_BASE64) {
  console.error("❌ MASTER_KEY_BASE64 missing in .env (must be 32 bytes base64)");
  process.exit(1);
}
const MASTER_KEY = Buffer.from(MASTER_KEY_BASE64, "base64");
if (MASTER_KEY.length !== 32) {
  console.error(
    `❌ MASTER_KEY_BASE64 must decode to 32 bytes. Got ${MASTER_KEY.length}.`
  );
  process.exit(1);
}

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_WEBHOOK_ID = process.env.HELIUS_WEBHOOK_ID || "";

console.log("🌐 RPC_URL =", RPC_URL);
console.log("🪐 JUPITER_API_BASE =", JUPITER_API_BASE);
console.log("🪐 JUPITER_API_KEY loaded =", JUPITER_API_KEY ? "YES" : "NO");
console.log("🔑 BOT_TOKEN loaded =", token ? "YES" : "NO");
console.log("🔔 HELIUS_API_KEY loaded =", HELIUS_API_KEY ? "YES" : "NO");
console.log("🔔 HELIUS_WEBHOOK_ID =", HELIUS_WEBHOOK_ID || "(not set)");

const bot = new Telegraf(token);
const WSOL_MINT = "So11111111111111111111111111111111111111112";

/* =========================
   TOKEN BLACKLIST
========================= */
const HARDCODED_BLACKLIST = new Set<string>([]);
function getBlacklist(): Set<string> {
  try { const db = loadDB() as any; return new Set([...HARDCODED_BLACKLIST, ...(db.tokenBlacklist ?? [])]); } catch { return HARDCODED_BLACKLIST; }
}
function addToBlacklist(mint: string): void {
  try { const db = loadDB() as any; if (!db.tokenBlacklist) db.tokenBlacklist = []; if (!db.tokenBlacklist.includes(mint)) { db.tokenBlacklist.push(mint); saveDB(db); } } catch {}
}
function removeFromBlacklist(mint: string): void {
  try { const db = loadDB() as any; if (!db.tokenBlacklist) return; db.tokenBlacklist = db.tokenBlacklist.filter((m: string) => m !== mint); saveDB(db); } catch {}
}
function isBlacklisted(mint: string): boolean { return getBlacklist().has(mint); }

/* =========================
   FEE COLLECTION — Jupiter Platform Fee + Accumulator Wallet
========================= */

const FEE_ACCUMULATOR_PUBKEY = process.env.FEE_ACCUMULATOR_PUBKEY ?? "69NC25VwwYhx51wkJYCo2umbjRv89ftwiFjyN6H1gMp6";
const FEE_ACCUMULATOR_SECRET = process.env.FEE_ACCUMULATOR_SECRET ?? "";
const PLATFORM_FEE_BPS = 100;
const ADMIN_USER_ID = Number(process.env.ADMIN_USER_ID ?? "0");

function getFeeAccumulatorKeypair(): Keypair | null {
  try {
    if (!FEE_ACCUMULATOR_SECRET) return null;
    const arr = JSON.parse(FEE_ACCUMULATOR_SECRET);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch { return null; }
}

async function creditReferrerFee(userId: number, feeSol: number): Promise<void> {
  try {
    const u = getUser(userId);
    if (!u.referredBy) return;

    const referrer = getUserByReferralCode(u.referredBy);
    if (!referrer) return;

    // Only credit within first 30 days
    const userCreatedAt = new Date(u.createdAt).getTime();
    if (Date.now() - userCreatedAt > 30 * 24 * 60 * 60 * 1000) return;

    const referrerShare = feeSol * 0.20;
    const referrerShareLamports = Math.floor(referrerShare * LAMPORTS_PER_SOL);
    if (referrerShareLamports < 1000) return; // skip dust

    // Get fee accumulator keypair to send payout
    const feeKp = getFeeAccumulatorKeypair();
    if (!feeKp) return;

    // Check fee accumulator has enough balance
    const feeBalance = await getFeeAccumulatorBalance();
    if (feeBalance < referrerShare + 0.001) return; // not enough to pay

    // Send SOL to referrer's default wallet
    const referrerWallet = referrer.wallets.find((w: any) => w.isDefault) ?? referrer.wallets[0];
    if (!referrerWallet) return;

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: feeKp.publicKey,
        toPubkey: new PublicKey(referrerWallet.pubkey),
        lamports: referrerShareLamports,
      })
    );

    const sig = await sendAndConfirmTransaction(connection, tx, [feeKp], {
      commitment: "confirmed",
    });

    // Update referrer stats
    referrer.referrals.lifetimeSolEarned += referrerShare;
    referrer.referrals.telegramReferrals = (referrer.referrals.telegramReferrals || 0);
    setUser(referrer);

    console.log(`🎁 Referral payout: ${referrerShare.toFixed(6)} SOL → user ${referrer.userId} | tx: ${sig}`);

    // Notify referrer
    bot.telegram.sendMessage(
      referrer.userId,
      `🎁 *Referral Reward!*\n\nOne of your referrals made a trade.\nYou earned: *${referrerShare.toFixed(6)} SOL*\n\nSent to your default wallet.\n\nKeep sharing your referral link to earn more! 🚀`,
      { parse_mode: "Markdown" }
    ).catch(() => {});

  } catch (e) {
    console.error("Referrer payout failed:", e);
  }
}

async function getFeeAccumulatorBalance(): Promise<number> {
  try {
    const lamports = await connection.getBalance(new PublicKey(FEE_ACCUMULATOR_PUBKEY));
    return lamports / LAMPORTS_PER_SOL;
  } catch { return 0; }
}

async function withdrawFees(toAddress: string, amountSol: number): Promise<string> {
  const kp = getFeeAccumulatorKeypair();
  if (!kp) throw new Error("Fee accumulator keypair not configured");
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: kp.publicKey,
      toPubkey: new PublicKey(toAddress),
      lamports,
    })
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [kp], { commitment: "confirmed" });
  console.log(`💸 Fee withdrawal: ${amountSol} SOL → ${toAddress} | tx: ${sig}`);
  return sig;
}

async function collectFee(
  userKp: Keypair,
  tradeAmountSol: number,
  userId: number,
  tradeType: string
): Promise<void> {
  try {
    const feeAmountLamports = Math.floor(tradeAmountSol * 0.01 * LAMPORTS_PER_SOL);
    if (feeAmountLamports < 1000) return;

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: userKp.publicKey,
        toPubkey: new PublicKey(FEE_ACCUMULATOR_PUBKEY),
        lamports: feeAmountLamports,
      })
    );

    const sig = await sendAndConfirmTransaction(connection, tx, [userKp], {
      commitment: "confirmed",
    });

    const feeSol = feeAmountLamports / LAMPORTS_PER_SOL;
    console.log(`💰 Fee: ${feeSol.toFixed(6)} SOL from user ${userId} (${tradeType})`);
    creditReferrerFee(userId, feeSol).catch(() => {});
  } catch (e) {
    console.error(`Fee collection failed for user ${userId}:`, e);
  }
}

/* =========================
   DB
========================= */

const DB_PATH = path.join(process.cwd(), "db.json");

type WalletRecord = {
  id: string;
  name?: string;
  pubkey: string;

  // keep BOTH for now
  secretKey?: string;      // plain JSON array — used for copytrade wallets & newly generated
  enc?: string;            // AES-256-GCM encrypted — used for trading wallets added via addWallet()
  iv?: string;
  tag?: string;

  createdAt: string;
  isDefault: boolean;
  isManual: boolean;
  enabled?: boolean;       // used by copytrade wallets
};

type GlobalSettings = {
  antiMev: boolean;
  initialIncludesFees: boolean;
  monitorMode: "SIMPLE" | "DETAILED";
  walletSelection: "SINGLE" | "MULTI";
};

type BuyChecks = {
  minMcEnabled: boolean
  minMc: number

  maxMcEnabled: boolean
  maxMc: number

  minLiquidityEnabled: boolean
  minLiquidity: number

  maxLiquidityEnabled: boolean
  maxLiquidity: number
}

type BuySettings = {
  confirmManualBuy: boolean;
  gasDeltaSol: number;
  priceImpactPct: number;
  slippagePct: number;
  allowAutoBuy: boolean;
  duplicateBuy: boolean;
  checks: BuyChecks;
};

type SellSettings = {
  confirmManualSell: boolean;
  gasDeltaSol: number;
  priceImpactPct: number;
  slippagePct: number;
  autoPnlCard: boolean;
  durationHours: number;
  invAndPayout: boolean;
  autoSellOnManualBuy: boolean;
  autoSellRetry: boolean;
};

type SellLimitType = "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_SL";

type SellLimitOrder = {
  id: string;
  type: SellLimitType;
  percentageChange: number;
  balancePct: number;
  durationHours: number;
  createdAt: string;
};

type BuyLimitTriggerType = "PRICE" | "MC";

type BuyLimitDraft = {
  multiBuy: boolean;
  triggerType: BuyLimitTriggerType;
  amountSol: number;
  durationHours: number;
};

type ReferralStats = {
  telegramReferrals: number;
  webReferrals: number;
  lifetimeSolEarned: number;
  lifetimeBonkEarned: number;
};

type UserRecord = {
  userId: number;
  createdAt: string;

  wallets: WalletRecord[];

  // ✅ ADD THIS
  copytradeWallets: WalletRecord[];

  global: GlobalSettings;
  buy: BuySettings;
  sell: SellSettings;
  sellLimits: SellLimitOrder[];

  positions?: {
    wallet: string;
    mint: string;
    entry: number;
    amount: number;
    createdAt: number;
  }[];

  referralCode: string;
  referredBy: string | null;
  referrals: ReferralStats;
};


type DB = { users: Record<string, any> };

function loadDB(): DB {
  try {
    if (!fs.existsSync(DB_PATH)) return { users: {} };
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.users ? parsed : { users: {} };
  } catch {
    return { users: {} };
  }
}

function saveDB(db: DB) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

function randomId() {
  return crypto.randomBytes(8).toString("hex");
}

function randomReferralCode() {
  return crypto.randomBytes(4).toString("hex");
}

function defaultUser(userId: number): UserRecord {
  return {
    userId,
    createdAt: new Date().toISOString(),
    wallets: [],
    copytradeWallets: [],
    global: {
      antiMev: true,
      initialIncludesFees: true,
      monitorMode: "DETAILED",
      walletSelection: "SINGLE",
    },
    buy: {
      confirmManualBuy: false,
      gasDeltaSol: 0.005,
      priceImpactPct: 25,
      slippagePct: 7,
      allowAutoBuy: true,
      duplicateBuy: false,
      checks: {
  minMcEnabled: false,
  minMc: 0,

  maxMcEnabled: false,
  maxMc: 0,

  minLiquidityEnabled: false,
  minLiquidity: 0,

  maxLiquidityEnabled: false,
  maxLiquidity: 0
}
    },
    sell: {
      confirmManualSell: false,
      gasDeltaSol: 0.005,
      priceImpactPct: 50,
      slippagePct: 15,
      autoPnlCard: true,
      durationHours: 168,
      invAndPayout: false,
      autoSellOnManualBuy: false,
      autoSellRetry: false,
    },
    sellLimits: [],

    referralCode: randomReferralCode(),
    referredBy: null,
    referrals: {
      telegramReferrals: 0,
      webReferrals: 0,
      lifetimeSolEarned: 0,
      lifetimeBonkEarned: 0,
    },
  };
}

function migrate(db: DB) {
  let changed = false;

  for (const [uid, u0] of Object.entries(db.users)) {
    const u: any = u0;

    if (!u.wallets && u.pubkey && u.enc && u.iv && u.tag) {
      const nu = defaultUser(u.userId ?? Number(uid));
      nu.wallets = [
        {
          id: randomId(),
          name: "wallet1",
          pubkey: u.pubkey,
          enc: u.enc,
          iv: u.iv,
          tag: u.tag,
          createdAt: u.createdAt ?? new Date().toISOString(),
          isDefault: true,
          isManual: true,
        },
      ];
      db.users[uid] = nu;
      changed = true;
      continue;
    }

    const base = defaultUser(u.userId ?? Number(uid));
    let updated = false;

    if (!u.wallets) {
      u.wallets = [];
      updated = true;
    }

    if (!u.copytradeWallets) {
      u.copytradeWallets = [];
      updated = true;
    }

    if (!u.global) {
      u.global = base.global;
      updated = true;
    } else {
      u.global = { ...base.global, ...u.global };
    }

    if (!u.buy) {
      u.buy = base.buy;
      updated = true;
    } else {
      u.buy = {
        ...base.buy,
        ...u.buy,
        checks: { ...base.buy.checks, ...(u.buy.checks ?? {}) },
      };
    }

    if (!u.sell) {
      u.sell = base.sell;
      updated = true;
    } else {
      u.sell = { ...base.sell, ...u.sell };
    }

    if (!Array.isArray(u.sellLimits)) {
      u.sellLimits = base.sellLimits;
      updated = true;
    }

    if (!u.referralCode) {
      u.referralCode = base.referralCode;
      updated = true;
    }

    if (u.referredBy === undefined) {
      u.referredBy = base.referredBy;
      updated = true;
    }

    if (!u.referrals) {
      u.referrals = base.referrals;
      updated = true;
    } else {
      u.referrals = { ...base.referrals, ...u.referrals };
    }

    if (updated) {
      db.users[uid] = u;
      changed = true;
    }
  }

  if (changed) saveDB(db);
}

function getUser(userId: number): UserRecord {
  const db = loadDB();
  migrate(db);

  const key = String(userId);
  if (!db.users[key]) {
    db.users[key] = defaultUser(userId);
    saveDB(db);
  }

  return db.users[key] as UserRecord;
}

function setUser(user: UserRecord) {
  const db = loadDB();
  migrate(db);
  db.users[String(user.userId)] = user;
  saveDB(db);
}

function encryptSecretKey(secretKey: Uint8Array) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decryptSecretKey(encB64: string, ivB64: string, tagB64: string): Uint8Array {
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const enc = Buffer.from(encB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", MASTER_KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return new Uint8Array(dec);
}

function getDefaultWallet(userId: number): WalletRecord | null {
  const u = getUser(userId);
  return u.wallets.find((w) => w.isDefault) ?? u.wallets[0] ?? null;
}

function addWallet(userId: number, name: string, kp: Keypair, makeDefault = false) {
  const u = getUser(userId);

  const willDefault = makeDefault || u.wallets.length === 0;
  if (willDefault) {
    u.wallets = u.wallets.map((w) => ({ ...w, isDefault: false }));
  }

  const { enc, iv, tag } = encryptSecretKey(kp.secretKey);

  const rec: WalletRecord = {
    id: randomId(),
    name,
    pubkey: kp.publicKey.toBase58(),
    enc,
    iv,
    tag,
    createdAt: new Date().toISOString(),
    isDefault: willDefault,
    isManual: willDefault ? true : false,
  };

  u.wallets.push(rec);

  if (!u.wallets.some((w) => w.isManual)) {
    const def = u.wallets.find((w) => w.isDefault) ?? u.wallets[0];
    if (def) def.isManual = true;
  }

  setUser(u);
  return rec;
}

function toggleManual(userId: number, walletId: string) {
  const u = getUser(userId);
  const wallet = u.wallets.find((w) => w.id === walletId);
  if (!wallet) return;

  if (wallet.isDefault) {
    wallet.isManual = true;
    setUser(u);
    return;
  }

  wallet.isManual = !wallet.isManual;

  if (!u.wallets.some((w) => w.isManual)) {
    const def = u.wallets.find((w) => w.isDefault) ?? u.wallets[0];
    if (def) def.isManual = true;
  }

  setUser(u);
}

function deleteWallet(userId: number, walletId: string) {
  const u = getUser(userId);
  const wallet = u.wallets.find((w) => w.id === walletId);
  if (!wallet) return;
  if (u.wallets.length <= 1) return;

  const wasDefault = wallet.isDefault;
  u.wallets = u.wallets.filter((w) => w.id !== walletId);

  if (wasDefault && u.wallets.length > 0) {
    u.wallets[0].isDefault = true;
    u.wallets[0].isManual = true;
  }

  if (!u.wallets.some((w) => w.isManual) && u.wallets.length > 0) {
    const def = u.wallets.find((w) => w.isDefault) ?? u.wallets[0];
    def.isManual = true;
  }

  setUser(u);
}

function loadWalletKeypair(w: WalletRecord): Keypair {
  // New wallets store secretKey as plain JSON array
  if (w.secretKey) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(w.secretKey)));
  }
  // Legacy wallets store encrypted key
  if (w.enc && w.iv && w.tag) {
    const secret = decryptSecretKey(w.enc!, w.iv!, w.tag!);
    return Keypair.fromSecretKey(secret);
  }
  throw new Error(`Wallet ${w.pubkey} has no usable key material`);
}

/* =========================
   COPYTRADE HELPERS
========================= */

function addCopytradeWallet(userId: number, pubkey: string) {
  const u = getUser(userId);

  if (u.copytradeWallets.some((w) => w.pubkey === pubkey)) {
    return false;
  }

  u.copytradeWallets.push({
    id: randomId(),
    pubkey,
    enabled: true,
    createdAt: new Date().toISOString(),
    isDefault: false,
    isManual: false,
  });

  setUser(u);
  return true;
}

function toggleCopytradeWallet(userId: number, id: string) {
  const u = getUser(userId);
  const w = u.copytradeWallets.find((x) => x.id === id);
  if (!w) return;
  w.enabled = !w.enabled;
  setUser(u);
}

function removeCopytradeWallet(userId: number, id: string) {
  const u = getUser(userId);
  u.copytradeWallets = u.copytradeWallets.filter((w) => w.id !== id);
  setUser(u);
}

function turnAllCopytrade(userId: number, enabled: boolean) {
  const u = getUser(userId);
  u.copytradeWallets = u.copytradeWallets.map((w) => ({
    ...w,
    enabled,
  }));
  setUser(u);
}

/* =========================
   REFERRAL HELPERS
========================= */

let botUsernameCache: string | null = null;

async function getBotUsername() {
  if (botUsernameCache) return botUsernameCache;
  const me = await bot.telegram.getMe();
  botUsernameCache = me.username ?? "";
  return botUsernameCache;
}

function getUserByReferralCode(code: string): UserRecord | null {
  const db = loadDB();
  migrate(db);

  for (const raw of Object.values(db.users)) {
    const u = raw as UserRecord;
    if (u.referralCode === code) return u;
  }

  return null;
}

function applyReferralIfValid(newUserId: number, referralCode: string) {
  const newUser = getUser(newUserId);

  if (!referralCode) return;
  if (newUser.referredBy) return;

  const inviter = getUserByReferralCode(referralCode);
  if (!inviter) return;
  if (inviter.userId === newUserId) return;

  newUser.referredBy = referralCode;
  setUser(newUser);

  inviter.referrals.telegramReferrals += 1;
  setUser(inviter);
}

async function buildReferralText(userId: number) {
  const u = getUser(userId);
  const botUsername = await getBotUsername();
  const refLink = `https://t.me/${botUsername}?start=ref_${u.referralCode}`;
  const shareText = encodeURIComponent(`🚀 I'm trading Solana tokens with Atlas — the fastest Telegram trading bot!\n\nJoin with my link and we both earn:`);
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${shareText}`;

  const db = loadDB();
  let totalReferrals = 0;
  let activeReferrals = 0;
  for (const raw of Object.values(db.users)) {
    const ru = raw as any;
    if (ru.referredBy === u.referralCode) {
      totalReferrals++;
      const createdAt = new Date(ru.createdAt).getTime();
      if (Date.now() - createdAt < 30 * 24 * 60 * 60 * 1000) activeReferrals++;
    }
  }

  return {
    text:
      `🌟 *Atlas Referral Program*\n\n` +
      `Earn *20% of all fees* from every trader you refer — paid automatically in SOL.\n\n` +
      `🔗 *Your link:*\n\`${refLink}\`\n\n` +
      `📊 *Your Stats*\n` +
      `┌ Total referrals: *${totalReferrals}*\n` +
      `├ Active (30d window): *${activeReferrals}*\n` +
      `└ Lifetime earned: *${u.referrals.lifetimeSolEarned.toFixed(4)} SOL*\n\n` +
      `💡 *How it works*\n` +
      `• Share your link — friend opens the bot\n` +
      `• You earn 20% of their fees for 30 days\n` +
      `• Paid instantly to your default wallet\n\n` +
      `📢 Running a Solana channel? Email us for a custom deal:\natlassolanabot@gmail.com`,
    shareUrl,
  };
}

function referralKeyboard(shareUrl: string) {
  return Markup.inlineKeyboard([
    [Markup.button.url("📤 Share My Link", shareUrl)],
    [Markup.button.callback("↩️ Close", "REF_CLOSE")],
  ]);
}

/* =========================
   Jupiter helpers
========================= */

async function fetchJson(url: string, options?: RequestInit) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);

  try {
    const res = await fetch(url, {
      ...options,
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": JUPITER_API_KEY!,
        Authorization: `Bearer ${JUPITER_API_KEY!}`,
        ...(options?.headers || {}),
      },
    });

    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : {};
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error(`Request timeout: ${url.slice(0, 80)}`);
    throw new Error(`Fetch error for ${url}: ${e?.message ?? String(e)}`);
  } finally {
    clearTimeout(t);
  }
}

function slippageBpsFromPct(pct: number) {
  const clamped = Math.max(0.1, Math.min(50, pct));
  return Math.round(clamped * 100);
}

async function jupiterQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
}) {
  const url = new URL(`${JUPITER_API_BASE}/swap/v1/quote`);
  url.searchParams.set("inputMint", params.inputMint);
  url.searchParams.set("outputMint", params.outputMint);
  url.searchParams.set("amount", params.amount);
  url.searchParams.set("slippageBps", String(params.slippageBps));
  url.searchParams.set("platformFeeBps", "0");
  return fetchJson(url.toString(), { method: "GET" });
}

async function jupiterSwap(params: { userPublicKey: string; quoteResponse: any }) {
  return fetchJson(`${JUPITER_API_BASE}/swap/v1/swap`, {
    method: "POST",
    body: JSON.stringify({
      quoteResponse: params.quoteResponse,
      userPublicKey: params.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  });
}

async function signAndSendSwapTx(userKp: Keypair, swapTxB64: string) {
  const txBuf = Buffer.from(swapTxB64, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([userKp]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  const conf = await connection.confirmTransaction(sig, "confirmed");
  if (conf.value.err) throw new Error(`Transaction failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

/* =========================
   Token balance helper
========================= */

type TokenHolding = {
  mint: string;
  amountRaw: string;
  decimals: number;
  uiAmount: number;
};

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

async function getTokenHolding(owner: PublicKey, mint: PublicKey): Promise<TokenHolding | null> {
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

  for (const programId of programs) {
    const resp = await connection.getParsedTokenAccountsByOwner(owner, { programId });

    for (const acc of resp.value) {
      const info: any = acc.account.data.parsed.info;
      const accMint = info.mint as string;
      if (accMint !== mint.toBase58()) continue;

      const tokenAmount = info.tokenAmount;
      const amountRaw = tokenAmount.amount as string;
      const decimals = tokenAmount.decimals as number;
      const uiAmount = (tokenAmount.uiAmount ?? 0) as number;

      return { mint: accMint, amountRaw, decimals, uiAmount };
    }
  }

  return null;
}

/* =========================
   Active token + drafts
========================= */

const activeBuyMint = new Map<number, string>();
const sendSolAddress = new Map<number, string>();
const buyLimitDrafts = new Map<number, BuyLimitDraft>();
const walletReorderMode = new Map<number, boolean>();
const importWalletNames = new Map<number, string>();
const walletFollowers = new Map<string, number[]>();

// Balance cache — avoids hitting RPC on every menu render
const balanceCache = new Map<string, { sol: number; ts: number }>();
const BALANCE_TTL_MS = 60_000; // 60 seconds

async function getCachedBalance(pubkey: string): Promise<number> {
  const now = Date.now();
  const cached = balanceCache.get(pubkey);
  if (cached && now - cached.ts < BALANCE_TTL_MS) return cached.sol;
  try {
    await new Promise(r => setTimeout(r, 500));
    const lamports = await connection.getBalance(new PublicKey(pubkey));
    const sol = lamports / LAMPORTS_PER_SOL;
    balanceCache.set(pubkey, { sol, ts: now });
    return sol;
  } catch {
    return cached?.sol ?? 0;
  }
}

function invalidateBalanceCache(pubkey: string) {
  balanceCache.delete(pubkey);
}

/* =========================
   DEXSCREENER PRICE FEED
========================= */

type TokenInfo = {
  price: number;        // USD
  priceSOL: number;     // price in SOL
  mc: number;           // market cap USD
  liquidity: number;    // liquidity USD
  symbol: string;
  name: string;
};

const tokenInfoCache = new Map<string, { data: TokenInfo; ts: number }>();
const TOKEN_INFO_TTL_MS = 15_000; // 15 seconds

async function fetchTokenInfo(mint: string): Promise<TokenInfo | null> {
  const now = Date.now();
  const cached = tokenInfoCache.get(mint);
  if (cached && now - cached.ts < TOKEN_INFO_TTL_MS) return cached.data;

  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!res.ok) return null;
    const json = await res.json() as any;

    const pairs: any[] = json?.pairs ?? [];
    if (!pairs.length) return null;

    // Pick the pair with highest liquidity
    const pair = pairs.sort((a: any, b: any) =>
      (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
    )[0];

    const data: TokenInfo = {
      price:     parseFloat(pair.priceUsd ?? "0"),
      priceSOL:  parseFloat(pair.priceNative ?? "0"),
      mc:        pair.fdv ?? pair.marketCap ?? 0,
      liquidity: pair.liquidity?.usd ?? 0,
      symbol:    pair.baseToken?.symbol ?? "???",
      name:      pair.baseToken?.name ?? "Unknown",
    };

    tokenInfoCache.set(mint, { data, ts: now });
    return data;
  } catch {
    return null;
  }
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtPrice(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.000001) return `$${n.toExponential(2)}`;
  if (n < 0.01)     return `$${n.toFixed(6)}`;
  return `$${n.toFixed(4)}`;
}

function addWalletFollower(wallet: string, userId: number) {

  if (!walletFollowers.has(wallet)) {
    walletFollowers.set(wallet, []);
  }

  walletFollowers.get(wallet)!.push(userId);

}

function rebuildWalletFollowers() {
  const db = loadDB();
  let count = 0;
  for (const raw of Object.values(db.users)) {
    const u = raw as any;
    if (!Array.isArray(u.copytradeWallets)) continue;
    for (const w of u.copytradeWallets) {
      if (w.enabled && w.pubkey && u.userId) {
        addWalletFollower(w.pubkey, u.userId);
        count++;
      }
    }
  }
  console.log(`✅ Rebuilt walletFollowers: ${count} active copytrade subscriptions`);
}

async function setHeliusWebhookAddresses(addresses: string[]) {
  if (!HELIUS_API_KEY || !HELIUS_WEBHOOK_ID) {
    console.warn("⚠️  HELIUS_API_KEY or HELIUS_WEBHOOK_ID not set — skipping webhook sync");
    return;
  }
  const webhookURL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/helius-webhook`
    : `https://atlas-solana-bot-production.up.railway.app/helius-webhook`;

  const res = await fetch(
    `https://api.helius.xyz/v0/webhooks/${HELIUS_WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        webhookURL,
        transactionTypes: ["SWAP"],
        accountAddresses: addresses,
        webhookType: "enhanced",
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    console.error(`❌ Helius webhook update failed (${res.status}):`, text);
  } else {
    console.log(`✅ Helius webhook synced — ${addresses.length} address(es) → ${webhookURL}`);
  }
}

async function syncHeliusWebhookFromDB() {
  const addresses = Array.from(walletFollowers.keys());
  await setHeliusWebhookAddresses(addresses);
}

function getBuyLimitDraft(userId: number): BuyLimitDraft {
  const existing = buyLimitDrafts.get(userId);
  if (existing) return existing;

  const draft: BuyLimitDraft = {
    multiBuy: false,
    triggerType: "PRICE",
    amountSol: 1,
    durationHours: 168,
  };
  buyLimitDrafts.set(userId, draft);
  return draft;
}

function setBuyLimitDraft(userId: number, patch: Partial<BuyLimitDraft>) {
  const d = getBuyLimitDraft(userId);
  const next = { ...d, ...patch };
  buyLimitDrafts.set(userId, next);
  return next;
}

function shortAddr(a: string, left = 6, right = 6) {
  if (a.length <= left + right + 3) return a;
  return `${a.slice(0, left)}...${a.slice(-right)}`;
}

/* =========================
   TEXT BUILDERS
========================= */

async function buildWalletPopupText(walletId: string, userId: number, fetchLive = false) {
  const u = getUser(userId);
  const wallet = u.wallets.find((w) => w.id === walletId);

  if (!wallet) return "Wallet not found.";

  if (fetchLive) invalidateBalanceCache(wallet.pubkey);
  const sol = await getCachedBalance(wallet.pubkey);

  const defaultDot = wallet.isDefault ? "🟢 Default" : "🔴 Default";
  const manualDot = wallet.isManual ? "🟢 Manual" : "🔴 Manual";

  return (
    `🔗 *SOL*\n\n` +
    `${wallet.name}: \`${wallet.pubkey}\`\n` +
    `${defaultDot} | ${manualDot} | 💰 ${sol.toFixed(4)} SOL\n\n` +
    `ℹ️ Enable "Manual" for wallets participating in manual buys.\n` +
    `Automated buys default to the "Default" wallet.`
  );
}

async function homeText(userId: number) {
  const def = getDefaultWallet(userId);

  const walletLine = def
    ? `💳 *Wallet:* \`${def.pubkey}\``
    : `⚠️ No wallet yet — tap *Wallet* to get started.`;

  const solBal = def ? await getCachedBalance(def.pubkey).catch(() => 0) : 0;
  const balLine = def ? `💰 *Balance:* ${solBal.toFixed(4)} SOL` : "";

  return (
    `🤖 *Atlas | Solana*\n` +
    `The fastest and most secure bot for trading any token on Solana.\n\n` +
    `⚡ *Quick buy/sell:* Paste any token CA and you're ready to go!\n` +
    `📊 *Copytrade* any wallet. Set *Limit Orders* with TP/SL.\n` +
    `🔒 Your keys are encrypted and never leave the bot.\n\n` +
    `${walletLine}\n` +
    `${balLine}`
  );
}

async function buildGlobalSettingsText(userId: number) {
  return (
    `🔗 *SOL*\n\n` +
    `Customize your general settings. Click on ⚙️ *Buy* or ⚙️ *Sell* to customize the settings of your buys and sells respectively.\n\n` +
    `ℹ️ Global Settings are common to all of your connected wallets.\n` +
    `ℹ️ Automated trade settings can override these through other modules later.\n`
  );
}

async function buildBuySettingsText(userId: number) {
  const u = getUser(userId);

  return (
    `🔗 *SOL*\n\n` +
    `Customize the settings of your *buys*.\n\n` +

    `ℹ️ Enable "Allow Auto Buy" to generally allow auto-buys through the bot.\n` +
    `This won't trigger any auto-buy unless you manually activate a particular signal/copytrade/auto-snipe later.\n` +
    `ℹ️ The settings of your automated trades can be further customized to override your global settings later.\n\n` +

   `📊 *Auto Buy Checks*\n` +
`Min MC: ${onOffDot(u.buy.checks.minMcEnabled)} ${
  u.buy.checks.minMcEnabled ? u.buy.checks.minMc : "Disabled"
}\n` +
`Max MC: ${onOffDot(u.buy.checks.maxMcEnabled)} ${
  u.buy.checks.maxMcEnabled ? u.buy.checks.maxMc : "Disabled"
}\n` +
`Min Liquidity: ${onOffDot(u.buy.checks.minLiquidityEnabled)} ${
  u.buy.checks.minLiquidityEnabled ? u.buy.checks.minLiquidity : "Disabled"
}\n` +
`Max Liquidity: ${onOffDot(u.buy.checks.maxLiquidityEnabled)} ${
  u.buy.checks.maxLiquidityEnabled ? u.buy.checks.maxLiquidity : "Disabled"
}\n`
    
  );
}

async function buildAutoBuyChecksText(userId: number) {
  return (
    `🔗 *SOL*\n\n` +
    `Below are optional checks that you can set up for *Auto Buy*. If any of the enabled limits is not met, Auto Buy won't trigger.\n\n` +
    `ℹ️ These checks can be further customized to override your global settings later.\n`
  );
}

async function buildSellSettingsText(userId: number) {
  return (
    `🔗 *SOL*\n\n` +
    `Customize the settings of your sells.\n\n` +
    `ℹ️ Enable "Auto Sell on Manual Buy" to automatically apply Sell Limit Orders following a manual buy.\n` +
    `ℹ️ Automated trades can override your global settings later through other modules.\n`
  );
}

async function buildWalletsText(userId: number, fetchLive = false) {
  const u = getUser(userId);

  if (u.wallets.length === 0) {
    return `🔗 *SOL*\n\nNo wallets yet.\nTap *Generate Wallet* below.`;
  }

  // Fetch all balances in parallel using cache
  if (fetchLive) {
    u.wallets.forEach(w => invalidateBalanceCache(w.pubkey));
  }
  const balances = await Promise.all(u.wallets.map(w => getCachedBalance(w.pubkey)));

  const lines: string[] = [];
  lines.push(`🔗 *SOL*`);
  lines.push("");

  for (let i = 0; i < u.wallets.length; i++) {
    const w = u.wallets[i];
    const sol = balances[i];
    const defaultDot = w.isDefault ? "🟢 Default" : "🔴 Default";
    const manualDot = w.isManual ? "🟢 Manual" : "🔴 Manual";
    lines.push(
      `${w.name}: \`${w.pubkey}\`\n${defaultDot} | ${manualDot} | 💰 ${sol.toFixed(3)} SOL`
    );
    lines.push("");
  }

  lines.push(`ℹ️ To transfer from a wallet or rename it, click on the wallet name.`);
  lines.push(`ℹ️ Enable "Manual" for the wallets participating in your manual buys.`);
  lines.push(`Automated buys will be defaulted to your "Default" wallet.`);

  return lines.join("\n");
}
function buildWalletHelpText() {
  return `📦 *Wallet Help*

Your wallet is used to send and receive SOL and tokens.

🟢 *Default*
The wallet used for automated buys.

🟢 *Manual*
Allows manual trading from this wallet.

You can:

• Rename wallets
• Send SOL
• Send tokens
• Import additional wallets

Automated trades always use the *Default wallet*.`;
}
async function buildCopytradeText(userId: number) {
  const u = getUser(userId);
  const selected =
  selectedCopytradeWallet.get(userId) ||
  getDefaultWallet(userId)?.name;

  const lines: string[] = [];
    lines.push("");
  lines.push(`⚡ Copytrade wallet: *${selected}*`);
  lines.push("");
  lines.push(`Copytrade the buys and sells of any wallet.`);
  lines.push("");
  lines.push(
    `ℹ️ "Copy Sell" will only activate when the copytrade wallet sells. This can work in parallel with "Auto Sell" which activates based on the limits you set.`
  );

  if (u.copytradeWallets.length > 0) {
    lines.push("");
    lines.push("");
    lines.push(`*Tracked wallets*`);
    lines.push(
      ...u.copytradeWallets.map(
        (w, i) =>
          `${i + 1}. \`${w.pubkey}\` | ${w.enabled ? "🟢 ON" : "🔴 OFF"}`
      )
    );
    const percent = copytradePercent.get(userId) ?? 100;

lines.push(`📊 Copy size: *${percent}%*`);
lines.push("");
  }

  return lines.join("\n");
}

async function buildBuyTokenText(userId: number) {
  const mint = activeBuyMint.get(userId);
  const u = getUser(userId);
  const def = getDefaultWallet(userId);

  if (!mint || !def) {
    return `🔗 *SOL*\n\nNo active token selected.\nTap Buy and paste the CA again.`;
  }

  // Fetch balance and price in parallel
  const [solBalance, info] = await Promise.all([
    getCachedBalance(def.pubkey),
    fetchTokenInfo(mint),
  ]);

  const mcStr  = info ? fmtUsd(info.mc)        : "Unknown";
  const prStr  = info ? fmtPrice(info.price)    : "Unknown";
  const liqStr = info ? fmtUsd(info.liquidity)  : "Unknown";
  const name   = info ? `${info.name} (${info.symbol})` : shortAddr(mint, 12, 8);

  return (
    `🌕 *${name}*  🔗 *SOL*\n` +
    `\`${mint}\`\n\n` +
    `🗳 MC *${mcStr}* | 💵 Price *${prStr}*\n` +
    `💧 Liquidity *${liqStr}*\n` +
    `🕒 Live prices via DexScreener\n` +
    `📌 No Orders\n\n` +
    `💰 *${def.name}* | ${solBalance.toFixed(4)} SOL\n\n` +
    `Slippage: ${u.buy.slippagePct}% | Gas: ${u.buy.gasDeltaSol} SOL`
  );
}

async function buildTrackTokenText(userId: number) {
  const mint = activeBuyMint.get(userId);
  const def = getDefaultWallet(userId);

  if (!mint || !def) {
    return `🔗 *SOL*\n\nNo active token selected.\nTap Buy and paste the CA again.`;
  }

  const [holding, info] = await Promise.all([
    getTokenHolding(new PublicKey(def.pubkey), new PublicKey(mint)).catch(() => null),
    fetchTokenInfo(mint),
  ]);

  const tokenBalance = holding?.uiAmount ?? 0;
  const hasBalance   = tokenBalance > 0;

  const mcStr  = info ? fmtUsd(info.mc)       : "Unknown";
  const prStr  = info ? fmtPrice(info.price)   : "Unknown";
  const liqStr = info ? fmtUsd(info.liquidity) : "Unknown";
  const name   = info ? `${info.name} (${info.symbol})` : shortAddr(mint, 12, 8);

  // Calculate PnL if we have a position
  const u = getUser(userId);
  const pos = (u.positions ?? []).find(p => p.mint === mint && p.wallet === def.name);
  let pnlLine = "";
  if (pos && pos.entry > 0 && info) {
    const currentValueSol = tokenBalance * info.priceSOL;
    const pnlPct = ((currentValueSol - pos.entry) / pos.entry) * 100;
    const pnlSign = pnlPct >= 0 ? "+" : "";
    pnlLine = `\n📊 PnL: *${pnlSign}${pnlPct.toFixed(2)}%* | Entry: ${pos.entry.toFixed(4)} SOL`;
  }

  return (
    `🌕 *${name}*\n` +
    `\`${mint}\`\n\n` +
    `💵 Price *${prStr}* | MC *${mcStr}*\n` +
    `💧 Liquidity *${liqStr}*\n\n` +
    (hasBalance
      ? `💼 Balance: *${tokenBalance.toLocaleString()} ${info?.symbol ?? ""}*${pnlLine}\n\n`
      : `⚠️ No balance detected in *${def.name}*\n\n`) +
    `📌 No Orders\n\n` +
    `ℹ️ Tap 🔄 to refresh prices`
  );
}

async function buildPositionsText(userId: number) {
  const u = getUser(userId);

  const selected = selectedPositionWallet.get(userId) || getDefaultWallet(userId)?.name;
  const def = u.wallets.find(w => w.name === selected);

  if (!def) {
    return `💼 *Wallet Positions*\n\n🔗 *SOL*\n\nNo wallet found.\nTap Wallet first.`;
  }

  const wallet = selectedPositionWallet.get(userId) || def.name;
  const positions = (u.positions || []).filter((p: any) => p.wallet === wallet);

  let posText = "";

  if (!positions.length) {
    posText = "🔴 No Positions found!\n\n";
  } else {
    // Fetch all prices in parallel
    const infos = await Promise.all(positions.map((p: any) => fetchTokenInfo(p.mint).catch(() => null)));

    for (let i = 0; i < positions.length; i++) {
      const p = positions[i] as any;
      const info = infos[i];
      const symbol = info?.symbol ?? shortAddr(p.mint, 4, 4);

      // Try to get token balance
      let tokenBalance = 0;
      try {
        const holding = await getTokenHolding(new PublicKey(def.pubkey), new PublicKey(p.mint));
        tokenBalance = holding?.uiAmount ?? 0;
      } catch {}

      const currentPrice = info?.price ?? 0;
      const currentValueSol = tokenBalance * (info?.priceSOL ?? 0);
      const entrySol = p.entry || p.entrySpentSol || 0;

      let pnlLine = "PnL: *N/A*";
      if (entrySol > 0 && currentValueSol > 0) {
        const pnlPct = ((currentValueSol - entrySol) / entrySol) * 100;
        const sign = pnlPct >= 0 ? "+" : "";
        pnlLine = `PnL: *${sign}${pnlPct.toFixed(2)}%*`;
      }

      posText +=
        `📈 *${symbol}*\n` +
        `\`${p.mint}\`\n` +
        `Balance: *${tokenBalance > 0 ? tokenBalance.toLocaleString() : "0"}*\n` +
        `Price: *${info ? fmtPrice(info.price) : "Unknown"}*\n` +
        `Worth: *${currentValueSol > 0 ? currentValueSol.toFixed(4) + " SOL" : "Unknown"}*\n` +
        `Entry: *${entrySol > 0 ? entrySol.toFixed(4) + " SOL" : "Not set"}*\n` +
        `${pnlLine}\n\n`;
    }
  }



return (
  `📦 *Wallet Positions*\n\n` +
  `🔗 *SOL*\n` +
  `💳 *${def.name}*: \`${def.pubkey}\`\n\n` +
  posText +
  `ℹ️ "Reset" will reset your "Initial" to the current "Worth" value of this token for this wallet.`
);
}

async function buildBuyLimitText(userId: number) {
  const mint = activeBuyMint.get(userId);
  const draft = getBuyLimitDraft(userId);

  return (
    `${mint ? `${shortAddr(mint, 12, 8)}\n${mint}\n\n` : ""}` +
    `⚙️ *Buy Limit Orders*\n\n` +
    `Set buy limit orders at a target price or market cap.\n\n` +
    `⚠️ You have no Buy Limits configured.\n\n` +
    `Trigger: *${draft.triggerType === "PRICE" ? "Price" : "MC"}*\n` +
    `Amount: *${draft.amountSol} SOL*\n` +
    `Duration: *${draft.durationHours}h*\n`
  );
}

async function buildLimitOrdersMiniText(userId: number) {
  const u = getUser(userId);

  const buyCount = 0; // buy limits coming later
  const sellCount = u.sellLimits.length;

  let text =
    `📊 Limit Orders\n\n` +
    `🟢 Buy Limits: ${buyCount}\n` +
    `🔴 Sell Limits: ${sellCount}\n\n`;

  if (sellCount === 0) {
    text += `No limit orders present\n`;
    return text;
  }

  text += `Active Orders\n\n`;

  u.sellLimits.forEach((o, i) => {
    const type =
      o.type === "TAKE_PROFIT"
        ? "📈 TP"
        : o.type === "STOP_LOSS"
        ? "📉 SL"
        : "📉 TSL";

    text +=
      `${i + 1}. ${type}\n` +
      `Change: ${o.percentageChange}%\n` +
      `Balance: ${o.balancePct}%\n\n`;
  });

  return text;
}

/* =========================
   KEYBOARDS
========================= */

function walletPopupKeyboard(walletId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("ℹ️ Help", "WP_HELP"),
      Markup.button.callback("↩️ Return", "WP_RETURN"),
    ],
    [
      Markup.button.callback("⬆️ Send SOL", `WP_SEND_SOL_${walletId}`),
      Markup.button.callback("⬆️ Send Tokens", `WP_SEND_TOKEN_${walletId}`),
    ],
    [
      Markup.button.callback("✏️ Rename", "WALLET_RENAME"),
      Markup.button.callback("🔑 Export Key", `WP_EXPORT_${walletId}`),
    ],
  ]);
}
function bonkMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🟢 Buy", "MENU_BUY"), Markup.button.callback("💸 Fund", "MENU_FUND")],
    [
      Markup.button.callback("👛 Wallet", "MENU_WALLET"),
      Markup.button.callback("🎁 Refer Friends", "MENU_REFER"),
      Markup.button.callback("📊 Positions", "MENU_POSITIONS"),
    ],
    [
      Markup.button.callback("❓ Help", "MENU_HELP"),
      Markup.button.callback("⚙️ Settings", "MENU_GLOBAL_SETTINGS"),
    ],
    [
      Markup.button.callback("🤖 Copytrade", "MENU_COPYTRADE"),
      Markup.button.callback("📈 Limit Orders", "MENU_LIMIT_ORDERS"),
    ],
    [Markup.button.callback("🔄 Refresh", "MENU_REFRESH")],
  ]);
}

function quickTradeMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🟢 Quick Buy (paste CA)", "MENU_QUICKBUY")],
    [Markup.button.callback("🔴 Quick Sell (paste CA)", "MENU_QUICKSELL")],
    [Markup.button.callback("Return", "BACK_HOME")],
  ]);
}

function onOffDot(isOn: boolean) {
  return isOn ? "🟢" : "🔴";
}

function copytradeKeyboard(userId: number) {

  const u = getUser(userId);

  const selected =
    selectedCopytradeWallet.get(userId) ||
    getDefaultWallet(userId)?.name;

  const walletButtons =
    u.wallets.length > 0
      ? u.wallets.map((w) =>
          Markup.button.callback(
            `${w.name === selected ? "🟢" : "🔴"} ${w.name}`,
            `CT_WALLET_${w.name}`
          )
        )
      : [Markup.button.callback("🔴 No Wallet", "NOOP")];

  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Return", "MAIN_MENU"),
      Markup.button.callback("100%", "CT_SIZE_100"),
      Markup.button.callback("Custom", "CT_SIZE_CUSTOM"),
    ],

    [
      Markup.button.callback("Turn All On", "CT_ALL_ON"),
      Markup.button.callback("Turn All Off", "CT_ALL_OFF"),
    ],

    [
      Markup.button.callback("Add Wallet", "CT_ADD_WALLET"),
    ],

    walletButtons


  ]);
}

function globalSettingsKeyboardBig(userId: number) {
  const u = getUser(userId);

  return Markup.inlineKeyboard([
    [
      Markup.button.callback("ℹ️ Help", "GS_HELP"),
      Markup.button.callback("🖨 Print", "GS_PRINT"),
      Markup.button.callback("Return", "GS_RETURN"),
    ],
    [
      Markup.button.callback("⚙️ Buy", "GS_BUY"),
      Markup.button.callback("⚙️ Sell", "GS_SELL"),
    ],
    [
      Markup.button.callback(
        `${onOffDot(u.global.initialIncludesFees)} Initial Includes Fees | ${u.global.initialIncludesFees ? "On" : "Off"}`,
        "GS_TOGGLE_FEES"
      ),
    ],
    [
      Markup.button.callback(
        `Monitor (All Chains) | ${u.global.monitorMode === "SIMPLE" ? "Brief" : "Detailed"}`,
        "GS_TOGGLE_MONITOR"
      ),
    ],
    [
      Markup.button.callback(
        `Wallet Selection (All Chains) | ${u.global.walletSelection === "SINGLE" ? "Single" : "Multi"}`,
        "GS_TOGGLE_WALLETSEL"
      ),
    ],
    [
      Markup.button.callback(
        `${onOffDot(u.global.antiMev)} Anti-MEV | ${u.global.antiMev ? "On" : "Off"}`,
        "GS_TOGGLE_ANTIMEV"
      ),
    ],
  ]);
}

function buySettingsKeyboardBig(userId: number) {
  const u = getUser(userId);

  return Markup.inlineKeyboard([
    [
      Markup.button.callback("ℹ️ Help", "BS_HELP"),
      Markup.button.callback("🖨 Print", "BS_PRINT"),
      Markup.button.callback("Return", "BS_RETURN"),
    ],
    [
      Markup.button.callback(
        `${onOffDot(!u.buy.confirmManualBuy)} Confirm Manual Buy`,
        "BS_TOGGLE_CONFIRM_MANUAL"
      ),
    ],
    [
      Markup.button.callback(`Gas Delta | ${u.buy.gasDeltaSol} SOL`, "BS_SET_GASDELTA"),
      Markup.button.callback(`Price Impact | ${u.buy.priceImpactPct}%`, "BS_SET_PRICEIMPACT"),
    ],
    [Markup.button.callback(`Slippage | ${u.buy.slippagePct}%`, "BS_SET_SLIPPAGE")],
    [Markup.button.callback("⬇️ Auto Buy Settings ⬇️", "NOOP")],
    [
      Markup.button.callback(
        `${onOffDot(u.buy.allowAutoBuy)} Allow Auto Buy`,
        "BS_TOGGLE_ALLOW_AUTO"
      ),
      Markup.button.callback(
        `${onOffDot(u.buy.duplicateBuy)} Duplicate Buy`,
        "BS_TOGGLE_DUPLICATE_BUY"
      ),
    ],
    [Markup.button.callback("⚙️ Auto Buy Checks", "BS_AUTO_BUY_CHECKS")],
  ]);
}

function autoBuyChecksKeyboard(userId: number) {
  const u = getUser(userId);

  return Markup.inlineKeyboard([
    [
      Markup.button.callback("ℹ️ Help", "ABC_HELP"),
      Markup.button.callback("Return", "ABC_RETURN"),
    ],
    [
      Markup.button.callback(
        `${onOffDot(u.buy.checks.minMcEnabled)} Min MC`,
        "ABC_TOGGLE_MIN_MC"
      ),
      Markup.button.callback(
        `${onOffDot(u.buy.checks.maxMcEnabled)} Max MC`,
        "ABC_TOGGLE_MAX_MC"
      ),
    ],
    [
      Markup.button.callback(
        `${onOffDot(u.buy.checks.minLiquidityEnabled)} Min Liquidity`,
        "ABC_TOGGLE_MIN_LIQ"
      ),
      Markup.button.callback(
        `${onOffDot(u.buy.checks.maxLiquidityEnabled)} Max Liquidity`,
        "ABC_TOGGLE_MAX_LIQ"
      ),
    ],
  ]);
}

function sellSettingsKeyboardBig(userId: number) {
  const u = getUser(userId);

  return Markup.inlineKeyboard([
    [
      Markup.button.callback("ℹ️ Help", "SS_HELP"),
      Markup.button.callback("🖨 Print", "SS_PRINT"),
      Markup.button.callback("Return", "SS_RETURN"),
    ],
    [
      Markup.button.callback(
        `${onOffDot(!u.sell.confirmManualSell)} Confirm Manual Sell`,
        "SS_TOGGLE_CONFIRM_MANUAL"
      ),
      Markup.button.callback(
        `${onOffDot(true)} Duration | ${u.sell.durationHours}h`,
        "SS_SET_DURATION"
      ),
    ],
    [
      Markup.button.callback(`Gas Delta | ${u.sell.gasDeltaSol} SOL`, "SS_SET_GASDELTA"),
      Markup.button.callback(`Price Impact | ${u.sell.priceImpactPct}%`, "SS_SET_PRICEIMPACT"),
    ],
    [Markup.button.callback(`Slippage | ${u.sell.slippagePct}%`, "SS_SET_SLIPPAGE")],
    [Markup.button.callback("⬇️ PnL Card Settings ⬇️", "NOOP")],
    [Markup.button.callback(`${onOffDot(u.sell.autoPnlCard)} Auto PnL Card`, "SS_TOGGLE_AUTOPNL")],
    [
      Markup.button.callback(`${onOffDot(true)} Duration | ${u.sell.durationHours}h`, "SS_SET_DURATION"),
      Markup.button.callback(`${onOffDot(u.sell.invAndPayout)} Inv. & Payout`, "SS_TOGGLE_INV_PAY"),
    ],
    [Markup.button.callback("⬇️ Auto Sell Settings ⬇️", "NOOP")],
    [Markup.button.callback(`${onOffDot(u.sell.autoSellOnManualBuy)} Auto Sell on Manual Buy`, "SS_TOGGLE_AUTOSELL_ON_MANUAL")],
    [Markup.button.callback(`${onOffDot(u.sell.autoSellRetry)} Auto Sell Retry`, "SS_TOGGLE_AUTOSELL_RETRY")],
    [Markup.button.callback("⚙️ Sell Limit", "SS_SELL_LIMIT")],
  ]);
}

function walletsKeyboard(userId: number) {
  const u = getUser(userId);
  const def = u.wallets.find((w) => w.isDefault);
  const reorder = walletReorderMode.get(userId) === true;

  const rows: any[] = [];

  rows.push([
    Markup.button.callback("ℹ️ Help", "W_HELP"),
    Markup.button.callback("Return", "W_RETURN"),
  ]);

  rows.push([
    Markup.button.callback(
      reorder ? "✅ Done Rearranging" : "🗂 Rearrange Wallets",
      "W_REARRANGE"
    ),
  ]);

  rows.push([
    Markup.button.callback(
      `Default Wallet | ${def ? def.name : "None"}`,
      "W_DEFAULT_INFO"
    ),
  ]);

  for (let i = 0; i < u.wallets.length; i++) {
    const w = u.wallets[i];

    if (reorder) {
      rows.push([
        Markup.button.callback("⬆️", `W_UP_${w.id}`),
        Markup.button.callback(`⚙️ ${w.name}`, "NOOP"),
        Markup.button.callback("⬇️", `W_DOWN_${w.id}`),
      ]);
    } else {
      const manualLabel = w.isManual ? "🟢 Manual" : "🔴 Manual";
      const deleteLabel = w.isDefault ? "➖" : "❌";

      rows.push([
        Markup.button.callback(`⚙️ ${w.name}`, `W_OPEN_${w.id ?? w.name}`),
        Markup.button.callback(manualLabel, `W_TOGMAN_${w.id ?? w.name}`),
        Markup.button.callback(deleteLabel, `W_DEL_${w.id ?? w.name}`),
      ]);
    }
  }

  if (!reorder) {
    rows.push([
      Markup.button.callback("Import Wallet", "W_IMPORT"),
      Markup.button.callback("Generate Wallet", "W_GENERATE"),
    ]);
    rows.push([
      Markup.button.callback("🔄 Refresh Balances", "W_REFRESH"),
    ]);
  }

  return Markup.inlineKeyboard(rows);
}

function sellLimitsKeyboard(userId: number) {
  const u = getUser(userId);
  const d = getDraft(userId);

  const delRow1: any[] = [];
  const delRow2: any[] = [];
  for (let i = 0; i < Math.min(3, u.sellLimits.length); i++) {
    delRow1.push(Markup.button.callback(`❌ Delete [${i + 1}]`, `SL_DEL_${i}`));
  }
  for (let i = 3; i < Math.min(6, u.sellLimits.length); i++) {
    delRow2.push(Markup.button.callback(`❌ Delete [${i + 1}]`, `SL_DEL_${i}`));
  }

  const rows: any[] = [
    [Markup.button.callback("Return", "SL_RETURN")],
    [Markup.button.callback("⬇️ Limit Type ⬇️", "NOOP")],
    [
      Markup.button.callback(typeBtnLabel(d, "TAKE_PROFIT", "Take Profit"), "SL_TYPE_TP"),
      Markup.button.callback(typeBtnLabel(d, "STOP_LOSS", "Stop Loss"), "SL_TYPE_SL"),
      Markup.button.callback(typeBtnLabel(d, "TRAILING_SL", "Trailing SL"), "SL_TYPE_TSL"),
    ],
    [Markup.button.callback("⬇️ Trigger ⬇️", "NOOP")],
    [Markup.button.callback("Percentage Change (type in chat)", "SL_SET_PCT")],
    [
      Markup.button.callback("Balance (type in chat)", "SL_SET_BAL"),
      Markup.button.callback("Duration (type in chat)", "SL_SET_DUR"),
    ],
    [Markup.button.callback("📌 Add Sell Limit Order", "SL_ADD")],
  ];

  if (delRow1.length) rows.push(delRow1);
  if (delRow2.length) rows.push(delRow2);

  rows.push([Markup.button.callback("Remove All Sell Limit Orders", "SL_CLEAR")]);

  return Markup.inlineKeyboard(rows);
}

function buyTokenKeyboard(userId: number) {
  const u = getUser(userId);
  const def = getDefaultWallet(userId);
  const walletLabel = def ? def.name : "wallet";
  const multiLabel = u.global.walletSelection === "MULTI" ? "🟢 Multi" : "🔴 Multi";

  return Markup.inlineKeyboard([
    [
      Markup.button.callback("📍 Track", "BT_TRACK"),
      Markup.button.callback("🔄 SOL", "BT_SOL"),
    ],
    [Markup.button.callback("⬅️ Go to Sell", "BT_GO_SELL")],
    [
      Markup.button.callback(`💳 ${walletLabel}`, "BT_WALLET"),
      Markup.button.callback(multiLabel, "BT_TOGGLE_MULTI"),
    ],
    [
      Markup.button.callback("0.01 SOL", "BT_AMT_001"),
      Markup.button.callback("0.05 SOL", "BT_AMT_005"),
      Markup.button.callback("0.3 SOL", "BT_AMT_03"),
    ],
    [
      Markup.button.callback("0.2 SOL", "BT_AMT_02"),
      Markup.button.callback("0.5 SOL", "BT_AMT_05"),
      Markup.button.callback("1 SOL", "BT_AMT_1"),
    ],
    [
      Markup.button.callback("Buy X SOL", "BT_BUY_X_SOL"),
      Markup.button.callback("Buy X Tokens", "BT_BUY_X_TOKENS"),
    ],
    [
      Markup.button.callback(`ⓑ Slippage | ${u.buy.slippagePct}%`, "BT_SHOW_SLIPPAGE"),
      Markup.button.callback(`ⓑ Gas | ${u.buy.gasDeltaSol} SOL`, "BT_SHOW_GAS"),
    ],
    [
      Markup.button.callback("🔄 Refresh", "BT_REFRESH"),
      Markup.button.callback("⚙️ Buy Limit", "BT_BUY_LIMIT"),
      Markup.button.callback("Return", "BACK_HOME"),
    ],
  ]);
}

function buyLimitKeyboard(userId: number) {
  const d = getBuyLimitDraft(userId);

  return Markup.inlineKeyboard([
    [
      Markup.button.callback("ℹ️ Help", "BL_HELP"),
      Markup.button.callback("↗️", "NOOP"),
      Markup.button.callback("Return", "BL_RETURN"),
    ],
    [
      Markup.button.callback(
        `${d.multiBuy ? "🟢" : "🔴"} Multi Buy | 1 ➡️`,
        "BL_TOGGLE_MULTI_BUY"
      ),
    ],
    [Markup.button.callback("⬇️ Trigger ⬇️", "NOOP")],
    [
      Markup.button.callback(
        `${d.triggerType === "PRICE" ? "🟢" : "🔴"} Price`,
        "BL_TRIGGER_PRICE"
      ),
      Markup.button.callback(
        `${d.triggerType === "MC" ? "🟢" : "🔴"} MC`,
        "BL_TRIGGER_MC"
      ),
    ],
    [
      Markup.button.callback(`Amount | ${d.amountSol} SOL`, "BL_SET_AMOUNT"),
      Markup.button.callback(`Duration | ${d.durationHours}h`, "BL_SET_DURATION"),
    ],
    [Markup.button.callback("📌 Add Buy Limit Order", "BL_ADD")],
  ]);
}

function trackTokenKeyboard(userId: number) {
  const u = getUser(userId);
  const multiLabel = u.global.walletSelection === "MULTI" ? "🟢 Multi" : "🔴 Multi";

  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⬅️", "TR_BACK"),
      Markup.button.callback("🔄 Refresh", "TR_REFRESH"),
      Markup.button.callback("➡️", "NOOP"),
    ],
    [
      Markup.button.callback("Copy CA", "TR_COPY_CA"),
      Markup.button.callback("⬅️ Go to Buy", "TR_GO_BUY"),
    ],
    [Markup.button.callback(multiLabel, "TR_TOGGLE_MULTI")],
    [Markup.button.callback("⚠️ No Balance Detected ⚠️", "NOOP")],
    [
      Markup.button.callback("Ⓢ Slippage | 15%", "NOOP"),
      Markup.button.callback("Ⓢ Gas | 0.005 SOL", "NOOP"),
    ],
    [
      Markup.button.callback("Delete ❌", "TR_DELETE"),
      Markup.button.callback("⚙️ Sell Limit", "TR_SELL_LIMIT"),
    ],
  ]);
}

function positionsKeyboard(userId: number) {
  const u = getUser(userId);

  const walletButtons =
    u.wallets.length > 0
      ? u.wallets.map((w) =>
         Markup.button.callback(
  `${selectedPositionWallet.get(userId) === w.name ? "🟢" : "🔴"} ${w.name}`,
  `POS_WALLET_${w.name}`
)
        )
      : [Markup.button.callback("🔴 No Wallet", "NOOP")];

  return Markup.inlineKeyboard([
    [
      Markup.button.callback("ℹ️ Help", "POS_HELP"),
      Markup.button.callback("↩️ Return", "POS_RETURN"),
    ],
    [Markup.button.callback("📈 Add Position", "POS_ADD")],
    [Markup.button.callback("🔄 Refresh", "POS_REFRESH")],
    [Markup.button.callback("⬇️ Select the wallet ⬇️", "NOOP")],
    walletButtons,
  ]);
}
bot.action("POS_RESET", async (ctx) => {
  await ctx.answerCbQuery("Resetting P/L to current value...");
  const userId = ctx.from!.id;
  const u = getUser(userId);
  const walletName = selectedPositionWallet.get(userId) || getDefaultWallet(userId)?.name;
  const walletRec = u.wallets.find(w => w.name === walletName);

  for (const p of (u.positions || []) as any[]) {
    if (p.wallet !== walletName) continue;
    try {
      const info = await fetchTokenInfo(p.mint).catch(() => null);
      const holding = walletRec
        ? await getTokenHolding(new PublicKey(walletRec.pubkey), new PublicKey(p.mint)).catch(() => null)
        : null;
      if (info && holding && holding.uiAmount > 0) {
        // Reset entry to current SOL value
        p.entry = holding.uiAmount * info.priceSOL;
      } else {
        p.entry = 0;
      }
    } catch { p.entry = 0; }
  }

  setUser(u);
  await ctx.answerCbQuery("✅ P/L reset to current value");
  await showPositionsMenu(ctx, userId);
});
function limitOrdersMiniKeyboard(userId: number) {
  const u = getUser(userId);

  const rows: any[] = [];

  if (u.sellLimits.length > 0) {
    u.sellLimits.forEach((o, i) => {
      rows.push([
        Markup.button.callback(
          `❌ Delete Order ${i + 1}`,
          `LO_DELETE_${i}`
        ),
      ]);
    });
  }

  rows.push([
    Markup.button.callback("◀ Prev", "LO_PREV"),
    Markup.button.callback("Page 1", "LO_PAGE"),
    Markup.button.callback("Next ▶", "LO_NEXT"),
  ]);

  rows.push([Markup.button.callback("Refresh", "LO_REFRESH")]);

  rows.push([Markup.button.callback("Close", "LO_CLOSE")]);

  return Markup.inlineKeyboard(rows);
}

/* =========================
   PnL card
========================= */

type PnlCardInput = {
  username: string;
  mintShort: string;
  heldFor: string;
  pnlPct: number;
  pnlSol: number;
  valueSol: number;
  costSol: number;
};

function escapeXml(s: string) {
  return s.replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  }[c] as string));
}

async function renderPnlCardPng(input: PnlCardInput): Promise<Buffer> {
  const pnlSign = input.pnlPct >= 0 ? "+" : "";
  const pnlColor = input.pnlPct >= 0 ? "#00E676" : "#FF5252";
  const pnlPctText = `${pnlSign}${input.pnlPct.toFixed(0)}%`;
  const bgColor = input.pnlPct >= 0 ? "#0B1020" : "#1A0B0B";

  const svg = `
  <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${bgColor}"/>
        <stop offset="60%" stop-color="#1A0F2E"/>
        <stop offset="100%" stop-color="#0A2A2A"/>
      </linearGradient>
      <linearGradient id="card" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.08"/>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0.03"/>
      </linearGradient>
      <filter id="glow">
        <feGaussianBlur stdDeviation="8" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="shadow">
        <feDropShadow dx="0" dy="4" stdDeviation="12" flood-color="#000000" flood-opacity="0.5"/>
      </filter>
    </defs>

    <!-- Background -->
    <rect width="1200" height="630" fill="url(#bg)"/>

    <!-- Glow orbs -->
    <circle cx="100" cy="150" r="200" fill="${pnlColor}" opacity="0.06"/>
    <circle cx="1100" cy="480" r="180" fill="#6E2BFF" opacity="0.08"/>

    <!-- Top bar -->
    <rect x="0" y="0" width="1200" height="6" fill="${pnlColor}" opacity="0.8"/>

    <!-- Bot branding -->
    <text x="60" y="60" font-family="Arial" font-size="22" fill="${pnlColor}" font-weight="700" opacity="0.9">⚡ ATLAS | SOLANA</text>
    <text x="1140" y="60" font-family="Arial" font-size="18" fill="#ffffff" opacity="0.4" text-anchor="end">t.me/SolPilotBot</text>

    <!-- Token name -->
    <text x="60" y="130" font-family="Arial" font-size="38" fill="#ffffff" font-weight="700">${escapeXml(input.mintShort)}</text>

    <!-- PnL percentage - BIG -->
    <text x="60" y="280" font-family="Arial" font-size="160" fill="${pnlColor}" font-weight="900" filter="url(#glow)" opacity="0.95">${escapeXml(pnlPctText)}</text>

    <!-- Divider -->
    <line x1="60" y1="320" x2="1140" y2="320" stroke="#ffffff" stroke-opacity="0.1" stroke-width="1"/>

    <!-- Stats card -->
    <rect x="60" y="345" width="500" height="180" rx="16" fill="url(#card)" filter="url(#shadow)"/>
    <rect x="620" y="345" width="520" height="180" rx="16" fill="url(#card)" filter="url(#shadow)"/>

    <!-- Left card content -->
    <text x="90" y="385" font-family="Arial" font-size="16" fill="#ffffff" opacity="0.5" font-weight="600">INVESTED</text>
    <text x="90" y="420" font-family="Arial" font-size="28" fill="#ffffff" font-weight="700">${input.costSol.toFixed(4)} SOL</text>

    <text x="90" y="465" font-family="Arial" font-size="16" fill="#ffffff" opacity="0.5" font-weight="600">RETURNED</text>
    <text x="90" y="500" font-family="Arial" font-size="28" fill="${pnlColor}" font-weight="700">${input.valueSol.toFixed(4)} SOL</text>

    <!-- Right card content -->
    <text x="650" y="385" font-family="Arial" font-size="16" fill="#ffffff" opacity="0.5" font-weight="600">PnL (SOL)</text>
    <text x="650" y="420" font-family="Arial" font-size="28" fill="${pnlColor}" font-weight="700">${pnlSign}${input.pnlSol.toFixed(4)} SOL</text>

    <text x="650" y="465" font-family="Arial" font-size="16" fill="#ffffff" opacity="0.5" font-weight="600">HELD FOR</text>
    <text x="650" y="500" font-family="Arial" font-size="28" fill="#ffffff" font-weight="700">${escapeXml(input.heldFor)}</text>

    <!-- Username -->
    <text x="60" y="590" font-family="Arial" font-size="20" fill="#ffffff" opacity="0.6">@${escapeXml(input.username)}</text>

    <!-- Watermark -->
    <text x="1140" y="590" font-family="Arial" font-size="16" fill="#ffffff" opacity="0.25" text-anchor="end">Trade smarter with Atlas | Solana</text>
  </svg>`.trim();

  return await sharp(Buffer.from(svg)).png().toBuffer();
}

/* =========================
   Sell limit draft
========================= */

type SellLimitDraft = {
  type: SellLimitType;
  percentageChange: number;
  balancePct: number;
  durationHours: number;
  activeField: "NONE" | "PCT" | "BAL" | "DUR";
};

const sellLimitDraft = new Map<number, SellLimitDraft>();

function getDraft(userId: number): SellLimitDraft {
  const existing = sellLimitDraft.get(userId);
  if (existing) return existing;

  const d: SellLimitDraft = {
    type: "TAKE_PROFIT",
    percentageChange: 5,
    balancePct: 100,
    durationHours: 168,
    activeField: "NONE",
  };
  sellLimitDraft.set(userId, d);
  return d;
}

function setDraft(userId: number, patch: Partial<SellLimitDraft>) {
  const d = getDraft(userId);
  const nd = { ...d, ...patch };
  sellLimitDraft.set(userId, nd);
  return nd;
}

function fmtLimitType(t: SellLimitType) {
  if (t === "TAKE_PROFIT") return "Take Profit";
  if (t === "STOP_LOSS") return "Stop Loss";
  return "Trailing SL";
}

function typeBtnLabel(d: SellLimitDraft, t: SellLimitType, name: string) {
  return `${d.type === t ? "🟢" : "🔴"} ${name}`;
}

function fmtOrderLine(o: SellLimitOrder, idx1: number) {
  const type =
    o.type === "TAKE_PROFIT"
      ? "📈 Take Profit"
      : o.type === "STOP_LOSS"
      ? "📉 Stop Loss"
      : "📉 Trailing SL";

  const pct =
    o.type === "STOP_LOSS"
      ? `${o.percentageChange}%`
      : `+${Math.abs(o.percentageChange)}%`;

  return (
    `[${idx1}] ${type}\n` +
    `• Percentage | ${pct}\n` +
    `• Balance | ${o.balancePct}%\n` +
    `• Duration | ${o.durationHours}h\n`
  );
}

async function buildSellLimitsText(userId: number) {
  const u = getUser(userId);
  const d = getDraft(userId);

  const howTo =
    `✅ *How to add a Sell Limit*\n` +
    `1) Choose your *Limit Type* (Take Profit / Stop Loss / Trailing SL)\n` +
    `2) Tap *Percentage Change* → then type the number in chat\n` +
    `3) Tap *Balance* → type % of your token balance to sell\n` +
    `4) Tap *Duration* → type hours (example: 168)\n` +
    `5) Press *Add Sell Limit Order*\n\n` +
    `ℹ️ *Trailing SL* follows price up, triggers if price drops by your trailing % from the highest point.\n\n`;

  const list =
    u.sellLimits.length === 0
      ? `No sell limit orders yet.\n\n`
      : u.sellLimits.map((o, i) => fmtOrderLine(o, i + 1)).join("\n");

  const builder =
    `*Builder*\n` +
    `Limit Type: *${fmtLimitType(d.type)}*\n` +
    `Percentage Change: *${d.activeField === "PCT" ? "🟢" : "🔴"} ${d.percentageChange}%*\n` +
    `Balance: *${d.activeField === "BAL" ? "🟢" : "🔴"} ${d.balancePct}%*\n` +
    `Duration: *${d.activeField === "DUR" ? "🟢" : "🔴"} ${d.durationHours}h*\n`;

  return `🔗 *SOL*\n\n⚙️ *Sell Limit Orders*\n\n${howTo}${list}\n${builder}`;
}

/* =========================
   SCREEN HELPERS
========================= */

async function showHomeMenu(ctx: any, userId: number) {
  const text = await homeText(userId);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...bonkMainMenu(),
    });
  } catch (e: any) {
    if (e?.description?.includes("message is not modified")) return;
    await ctx.reply(text, {
      parse_mode: "Markdown",
      ...bonkMainMenu(),
    });
  }
}

async function showWalletMenu(ctx: any, userId: number, fetchLive = false) {
  const text = await buildWalletsText(userId, fetchLive);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...walletsKeyboard(userId),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "Markdown",
      ...walletsKeyboard(userId),
    });
  }
}

async function showCopytradeMenu(ctx: any, userId: number) {
  const text = await buildCopytradeText(userId);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...copytradeKeyboard(userId),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "Markdown",
      ...copytradeKeyboard(userId),
    });
  }
}

async function showGlobalSettingsMenu(ctx: any, userId: number) {
  const text = await buildGlobalSettingsText(userId);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...globalSettingsKeyboardBig(userId),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "Markdown",
      ...globalSettingsKeyboardBig(userId),
    });
  }
}

async function showBuySettingsMenu(ctx: any, userId: number) {
  const text = await buildBuySettingsText(userId);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...buySettingsKeyboardBig(userId),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "Markdown",
      ...buySettingsKeyboardBig(userId),
    });
  }
}

async function showAutoBuyChecksMenu(ctx: any, userId: number) {
  const text = await buildAutoBuyChecksText(userId);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...autoBuyChecksKeyboard(userId),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "Markdown",
      ...autoBuyChecksKeyboard(userId),
    });
  }
}

async function showSellSettingsMenu(ctx: any, userId: number) {
  const text = await buildSellSettingsText(userId);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...sellSettingsKeyboardBig(userId),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "Markdown",
      ...sellSettingsKeyboardBig(userId),
    });
  }
}

async function showSellLimitsMenu(ctx: any, userId: number) {
  const text = await buildSellLimitsText(userId);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...sellLimitsKeyboard(userId),
    });
  } catch (e: any) {
    if (e?.description?.includes("message is not modified")) return;
    await ctx.reply(text, {
      parse_mode: "Markdown",
      ...sellLimitsKeyboard(userId),
    });
  }
}

async function showBuyTokenMenu(ctx: any, userId: number) {
  const text = await buildBuyTokenText(userId);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...buyTokenKeyboard(userId),
    });
  } catch (e: any) {
    if (e?.description?.includes("message is not modified")) return;
    await ctx.reply(text, {
      parse_mode: "Markdown",
      ...buyTokenKeyboard(userId),
    });
  }
}

async function showBuyLimitMenu(ctx: any, userId: number) {
  const text = await buildBuyLimitText(userId);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...buyLimitKeyboard(userId),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "Markdown",
      ...buyLimitKeyboard(userId),
    });
  }
}

async function showTrackTokenMenu(ctx: any, userId: number) {
  const text = await buildTrackTokenText(userId);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...trackTokenKeyboard(userId),
    });
  } catch (e: any) {
    if (e?.description?.includes("message is not modified")) return;
    await ctx.reply(text, {
      parse_mode: "Markdown",
      ...trackTokenKeyboard(userId),
    });
  }
}

async function showPositionsMenu(ctx: any, userId: number) {
  const text = await buildPositionsText(userId);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...positionsKeyboard(userId),
    });
  } catch (e: any) {
    if (e?.description?.includes("message is not modified")) return;
    await ctx.reply(text, {
      parse_mode: "Markdown",
      ...positionsKeyboard(userId),
    });
  }
}

async function showReferralMenu(ctx: any, userId: number) {
  const { text, shareUrl } = await buildReferralText(userId);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...referralKeyboard(shareUrl),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "Markdown",
      ...referralKeyboard(shareUrl),
    });
  }
}

async function executeBuyFromActiveMint(
  ctx: any,
  userId: number,
  solAmount: number
) {
  const mintStr = activeBuyMint.get(userId);
  if (!mintStr) {
    await ctx.reply("❌ No active token selected. Tap Buy and paste the CA again.");
    return;
  }

  if (isBlacklisted(mintStr)) {
    await ctx.reply(`🚫 *Token Blocked*\n\nThis token is blacklisted.\n\n\`${mintStr}\``, { parse_mode: "Markdown" });
    return;
  }

  const u = getUser(userId);

  // MULTI-WALLET MODE
  if (u.global.walletSelection === "MULTI") {
    const manualWallets = u.wallets.filter(w => w.isManual);
    if (manualWallets.length === 0) {
      await ctx.reply("❌ No Manual wallets enabled. Go to Wallet and toggle Manual on.");
      return;
    }
    const loading = await ctx.reply(`⏳ Buying ${solAmount} SOL on ${manualWallets.length} wallets...`);
    const results = await Promise.allSettled(manualWallets.map(async (wallet) => {
      const walletBalance = await connection.getBalance(new PublicKey(wallet.pubkey));
      if (walletBalance / LAMPORTS_PER_SOL < solAmount + 0.01) throw new Error(`${wallet.name}: insufficient balance`);
      const userKp = loadWalletKeypair(wallet);
      const mint = new PublicKey(mintStr);
      const amountLamports = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));
      const slippageSteps = [slippageBpsFromPct(u.buy.slippagePct), slippageBpsFromPct(Math.min(u.buy.slippagePct*2,50)), slippageBpsFromPct(Math.min(u.buy.slippagePct*4,100))];
      let sig: string | null = null; let lastErr: any = null;
      for (const bps of slippageSteps) {
        try {
          const quote = await jupiterQuote({ inputMint: WSOL_MINT, outputMint: mint.toBase58(), amount: amountLamports.toString(), slippageBps: bps });
          const swap = await jupiterSwap({ userPublicKey: wallet.pubkey, quoteResponse: quote });
          const swapTxB64 = (swap as any)?.swapTransaction;
          if (!swapTxB64) throw new Error("No swapTransaction");
          sig = await signAndSendSwapTx(userKp, swapTxB64);
          collectFee(userKp, solAmount, userId, "BUY").catch(() => {});
          break;
        } catch (e) { lastErr = e; }
      }
      if (!sig) throw new Error(`${wallet.name}: ${lastErr?.message ?? "failed"}`);
      try {
        const fresh = getUser(userId);
        if (!fresh.positions) fresh.positions = [];
        const existing = fresh.positions.find((p: any) => p.mint === mintStr && p.wallet === wallet.name);
        if (existing) { (existing as any).entry = ((existing as any).entry ?? 0) + solAmount; }
        else { fresh.positions.push({ wallet: wallet.name, mint: mintStr, entry: solAmount, amount: 0, createdAt: Date.now() } as any); }
        invalidateBalanceCache(wallet.pubkey);
        setUser(fresh);
      } catch {}
      return { name: wallet.name, sig };
    }));
    const succeeded = results.filter(r => r.status === "fulfilled") as PromiseFulfilledResult<{name: string, sig: string}>[];
    const failed2 = results.filter(r => r.status === "rejected") as PromiseRejectedResult[];
    let summary = `✅ *Multi-wallet Buy Complete*\n\nSpent: *${solAmount} SOL* per wallet\n\n`;
    if (succeeded.length) summary += succeeded.map(r => `✅ *${r.value.name}*: \`${r.value.sig.slice(0,20)}...\``).join("\n") + "\n";
    if (failed2.length) summary += "\n" + failed2.map(r => `❌ ${r.reason?.message ?? "failed"}`).join("\n");
    await ctx.telegram.editMessageText(loading.chat.id, loading.message_id, undefined, summary, { parse_mode: "Markdown" });
    return;
  }

  // SINGLE WALLET MODE
const selected =
  selectedPositionWallet.get(userId) ||
  getDefaultWallet(userId)?.name;

const def = u.wallets.find(w => w.name === selected);


if (!def) {
  await ctx.reply("❌ Wallet not found.");
  return;
}

  let mint: PublicKey;
  try {
    mint = new PublicKey(mintStr);
  } catch {
    await ctx.reply("❌ Invalid active mint.");
    return;
  }

  const loading = await ctx.reply(`⏳ Buying ${solAmount} SOL worth...`);

  // Slippage auto-retry: try up to 3 times, doubling slippage each attempt
  const slippageSteps = [
    slippageBpsFromPct(u.buy.slippagePct),
    slippageBpsFromPct(Math.min(u.buy.slippagePct * 2, 50)),
    slippageBpsFromPct(Math.min(u.buy.slippagePct * 4, 100)),
  ];

  let lastError: any = null;
  let sig: string | null = null;
  let usedSlippageBps = slippageSteps[0];

  // Balance check
  const walletBalance = await connection.getBalance(new PublicKey(def.pubkey));
  const walletSol = walletBalance / LAMPORTS_PER_SOL;
  if (walletSol < solAmount + 0.01) {
    await ctx.telegram.editMessageText(
      loading.chat.id, loading.message_id, undefined,
      `❌ Insufficient balance. You have *${walletSol.toFixed(4)} SOL* but need ~*${(solAmount + 0.01).toFixed(4)} SOL*.\n\nFund your wallet first.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const userKp = loadWalletKeypair(def);
  const amountLamports = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));
  if (amountLamports <= 0n) {
    await ctx.telegram.editMessageText(loading.chat.id, loading.message_id, undefined, `❌ Amount too small.`);
    return;
  }

  for (let attempt = 0; attempt < slippageSteps.length; attempt++) {
    usedSlippageBps = slippageSteps[attempt];
    const slippagePct = (usedSlippageBps / 100).toFixed(1);

    if (attempt > 0) {
      await ctx.telegram.editMessageText(
        loading.chat.id, loading.message_id, undefined,
        `⏳ Attempt ${attempt + 1}/3 with slippage *${slippagePct}%*...`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }

    try {
      const quote = await jupiterQuote({
        inputMint: WSOL_MINT,
        outputMint: mint.toBase58(),
        amount: amountLamports.toString(),
        slippageBps: usedSlippageBps,
      });

      const swap = await jupiterSwap({ userPublicKey: def.pubkey, quoteResponse: quote });
      const swapTxB64 = (swap as any)?.swapTransaction;
      if (!swapTxB64) throw new Error("No swapTransaction returned from Jupiter.");

      sig = await signAndSendSwapTx(userKp, swapTxB64);
      lastError = null;
      break; // success
    } catch (e: any) {
      lastError = e;
      console.error(`Buy attempt ${attempt + 1} failed (slippage ${slippagePct}%):`, e?.message);
    }
  }

  if (!sig) {
    await ctx.telegram.editMessageText(
      loading.chat.id, loading.message_id, undefined,
      `❌ Buy failed after 3 attempts:\n${lastError?.message ?? String(lastError)}`
    );
    return;
  }

  // Collect 1% fee
  collectFee(userKp, solAmount, userId, "BUY").catch(() => {});

  // Track position entry
  try {
    const fresh = getUser(userId);
    if (!fresh.positions) fresh.positions = [];
    const walletName = def.name ?? "wallet1";
    const existingPos = fresh.positions.find((p: any) => p.mint === mint.toBase58() && p.wallet === walletName);
    if (existingPos) {
      (existingPos as any).entry = ((existingPos as any).entry ?? 0) + solAmount;
    } else {
      fresh.positions.push({ wallet: walletName, mint: mint.toBase58(), entry: solAmount, amount: 0, createdAt: Date.now() } as any);
    }
    invalidateBalanceCache(def.pubkey);
    setUser(fresh);
  } catch {}

  const info = await fetchTokenInfo(mint.toBase58()).catch(() => null);
  const priceStr = info ? fmtPrice(info.price) : "Unknown";
  const mcStr    = info ? fmtUsd(info.mc)      : "Unknown";
  const usedSlippagePct = (usedSlippageBps / 100).toFixed(2);

  await ctx.telegram.editMessageText(
    loading.chat.id, loading.message_id, undefined,
    `✅ *Bought*\n\n` +
    `${info ? `*${info.name} (${info.symbol})*\n` : ""}` +
    `\`${mint.toBase58()}\`\n\n` +
    `Spent: *${solAmount} SOL*\n` +
    `Price: *${priceStr}*\n` +
    `MC: *${mcStr}*\n` +
    `Slippage used: *${usedSlippagePct}%*\n\n` +
    `🧾 Tx: \`${sig}\``,
    { parse_mode: "Markdown" }
  );
}

/* =========================
   START / HOME
========================= */
async function handleHeliusEvent(event: any) {

  if (event.type !== "SWAP") return;

  const wallet = event.feePayer;

  const transfers = event.tokenTransfers;
  if (!transfers || transfers.length < 2) return;

  const input = transfers[0];
  const output = transfers[1];

  const inputMint = input.mint;
  const outputMint = output.mint;

  const inputAmount = Number(input.tokenAmount);
  const outputAmount = Number(output.tokenAmount);

  const SOL_MINT = "So11111111111111111111111111111111111111112";

  let side = "UNKNOWN";
  let tokenMint = "";
  let solAmount = 0;

  if (inputMint === SOL_MINT) {
    side = "BUY";
    tokenMint = outputMint;
    solAmount = inputAmount;
  }

  if (outputMint === SOL_MINT) {
    side = "SELL";
    tokenMint = inputMint;
    solAmount = outputAmount;
  }

  if (side === "UNKNOWN") return;

  if (side !== "UNKNOWN") console.log(`Trade ${side}: ${tokenMint} | ${solAmount} SOL | wallet: ${wallet}`);

  // Fire copytrade for all followers of this wallet
  const followers = walletFollowers.get(wallet);
  if (!followers || followers.length === 0) return;

  for (const userId of followers) {
    try {
      await executeCopyTradeForUser(userId, side, tokenMint, solAmount);
    } catch (e) {
      console.error(`Copytrade failed for user ${userId}:`, e);
    }
  }
}

async function executeCopyTradeForUser(
  userId: number,
  side: string,
  tokenMint: string,
  solAmount: number
) {
  const u = getUser(userId);

  if (!u.buy.allowAutoBuy) {
    console.log(`User ${userId} has allowAutoBuy disabled — skipping`);
    return;
  }

  const wallet = getDefaultWallet(userId);
  if (!wallet) {
    console.log(`User ${userId} has no wallet — skipping`);
    return;
  }

  const pct = copytradePercent.get(userId) ?? 100;
  const adjustedAmount = solAmount * (pct / 100);

  const userKp = loadWalletKeypair(wallet);

  if (side === "BUY") {
    const amountLamports = BigInt(Math.floor(adjustedAmount * LAMPORTS_PER_SOL));
    if (amountLamports <= 0n) return;

    const quote = await jupiterQuote({
      inputMint: WSOL_MINT,
      outputMint: tokenMint,
      amount: amountLamports.toString(),
      slippageBps: slippageBpsFromPct(u.buy.slippagePct),
    });

    const swap = await jupiterSwap({
      userPublicKey: wallet.pubkey,
      quoteResponse: quote,
    });

    const swapTxB64 = (swap as any)?.swapTransaction;
    if (!swapTxB64) throw new Error("No swapTransaction from Jupiter");

    const sig = await signAndSendSwapTx(userKp, swapTxB64);
    console.log(`Copytrade BUY for user ${userId}: ${sig}`);

    // Collect 1% fee
    collectFee(userKp, adjustedAmount, userId, "COPYTRADE").catch(() => {});

    await bot.telegram.sendMessage(
      userId,
      `🤖 *Copytrade BUY executed*\n\nToken: \`${tokenMint}\`\nAmount: *${adjustedAmount.toFixed(4)} SOL* (${pct}%)\n\nTx: \`${sig}\``,
      { parse_mode: "Markdown" }
    ).catch(() => {});

  } else if (side === "SELL") {
    // Sell the same % of our token balance
    const owner = new PublicKey(wallet.pubkey);
    const mint = new PublicKey(tokenMint);
    const holding = await getTokenHolding(owner, mint);
    if (!holding || BigInt(holding.amountRaw) <= 0n) return;

    const sellRaw = (BigInt(holding.amountRaw) * BigInt(pct)) / 100n;
    if (sellRaw <= 0n) return;

    const quote = await jupiterQuote({
      inputMint: tokenMint,
      outputMint: WSOL_MINT,
      amount: sellRaw.toString(),
      slippageBps: slippageBpsFromPct(u.sell.slippagePct),
    });

    const swap = await jupiterSwap({
      userPublicKey: wallet.pubkey,
      quoteResponse: quote,
    });

    const swapTxB64 = (swap as any)?.swapTransaction;
    if (!swapTxB64) throw new Error("No swapTransaction from Jupiter");

    const sig = await signAndSendSwapTx(userKp, swapTxB64);
    console.log(`Copytrade SELL for user ${userId}: ${sig}`);

    await bot.telegram.sendMessage(
      userId,
      `🤖 *Copytrade SELL executed*\n\nToken: \`${tokenMint}\`\nSold: *${pct}%* of balance\n\nTx: \`${sig}\``,
      { parse_mode: "Markdown" }
    ).catch(() => {});
  }
}

/* =========================
   START COMMAND
========================= */

bot.command("start", async (ctx) => {
  const userId = ctx.from!.id;
  const args = ctx.message.text.split(" ");
  const startParam = args[1] ?? "";

  // Handle referral
  if (startParam.startsWith("ref_")) {
    const code = startParam.slice(4);
    applyReferralIfValid(userId, code);
  }

  // Auto-create wallet if none exists
  const u = getUser(userId);
  if (u.wallets.length === 0) {
    addWallet(userId, "wallet1", Keypair.generate(), true);
  }

  const text = await homeText(userId);
  await ctx.reply(text, {
    parse_mode: "Markdown",
    ...bonkMainMenu(),
  });
});

bot.command("cancel", async (ctx) => {
  const userId = ctx.from!.id;
  setFlow(userId, "NONE");
  await ctx.reply("Cancelled.", { ...bonkMainMenu() });
});

bot.command("pnl", async (ctx) => {
  const username = ctx.from?.username ? `@${ctx.from.username}` : `User ${ctx.from?.id}`;

  const png = await renderPnlCardPng({
    username,
    mintShort: "TEST…pump",
    heldFor: "0d 0h 5m",
    pnlPct: 123,
    pnlSol: 0.012345,
    valueSol: 0.022222,
    costSol: 0.009877,
  });

  await ctx.replyWithPhoto({ source: png }, { caption: "📈 PnL Card (demo)" });
});

bot.action("BACK_HOME", async (ctx) => {
  await ctx.answerCbQuery();
  await showHomeMenu(ctx, ctx.from!.id);
});



bot.action("POS_ADD", async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from!.id;

  setFlow(userId, "AWAIT_POSITION_CA");

  await ctx.reply("Paste the token contract address (CA).");
});

bot.action("MENU_REFRESH", async (ctx) => {
  await ctx.answerCbQuery();
  await showHomeMenu(ctx, ctx.from!.id);
});

bot.action("BUY_PRINT", async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from!.id;

  const text = await buildBuySettingsText(userId);

  await ctx.reply(text, {
    parse_mode: "Markdown",
  });
});

bot.action("HELP", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
`ℹ️ *Bot Help*

Paste a token CA to buy or sell tokens.

Main features:
• Buy tokens instantly
• Sell tokens instantly
• Copytrade wallets
• Limit orders
• Custom trading settings

Wallet tips:
• Enable *Manual* wallets for manual buys
• Automated trades use the *Default* wallet

Type /cancel anytime to exit a prompt.`,
{ parse_mode: "Markdown" }
  );
});

bot.action("MENU_HELP", async (ctx) => {
  await ctx.answerCbQuery();

  const text =
    `📘 *Atlas | Solana — Help Guide*\n\n` +

    `🚀 *Quick Start*\n` +
    `1. Tap *Wallet* → *Generate Wallet* to create your trading wallet\n` +
    `2. Send SOL to your wallet address to fund it\n` +
    `3. Tap *Buy*, paste any token contract address (CA), choose your amount\n` +
    `4. To sell, paste the CA again or tap *Go to Sell* from the buy screen\n\n` +

    `🗂 *Main Menu Buttons*\n` +
    `• *Buy* — paste a token CA to open the buy screen\n` +
    `• *Fund* — coming soon: fund your wallet with a card\n` +
    `• *Wallet* — manage your wallets, send SOL/tokens, import keys\n` +
    `• *Refer Friends* — get your referral link and track earnings\n` +
    `• *Positions* — view and track tokens you hold\n` +
    `• *Settings* — configure buy/sell behaviour, slippage, gas, and more\n` +
    `• *Copytrade* — follow any wallet and auto-copy their swaps\n` +
    `• *Limit Orders* — set take-profit and stop-loss orders\n` +
    `• *Refresh* — reload the home screen\n\n` +

    `💡 *Tips*\n` +
    `• Each section has its own *ℹ️ Help* button with detailed explanations\n` +
    `• Type /cancel anytime to exit a prompt\n` +
    `• Your private keys are AES-256 encrypted and stored locally\n\n` +

    `📧 *Customer Support*\n` +
    `For help, questions or feedback, contact us at:\n` +
    `atlassolanabot@gmail\.com\n\n` +

    `⚠️ *Reminder*\n` +
    `Always verify token contracts before buying. Never share your private keys.`;

  await ctx.reply(text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("⬅ Return", "RETURN")],
    ]),
  });
});

bot.action("RETURN", async (ctx) => {
  await ctx.answerCbQuery();
  await showHomeMenu(ctx, ctx.from!.id);
});

bot.action("MENU_REFER", async (ctx) => {
  await ctx.answerCbQuery();
  await showReferralMenu(ctx, ctx.from!.id);
});

bot.action("REF_CLOSE", async (ctx) => {
  await ctx.answerCbQuery();
  await showHomeMenu(ctx, ctx.from!.id);
});

bot.action("MENU_POSITIONS", async (ctx) => {
  await ctx.answerCbQuery();
  await showPositionsMenu(ctx, ctx.from!.id);
});

bot.action("MENU_COPYTRADE", async (ctx) => {
  await ctx.answerCbQuery();
  await showCopytradeMenu(ctx, ctx.from!.id);
});

bot.action("MENU_FUND", async (ctx) => {
  await ctx.answerCbQuery();

  const text =
    `💳 *Fund Your Wallet*\n\n` +
    `We are currently preparing seamless funding options for your wallet.\n\n` +
    `Soon you will be able to buy *SOL instantly* using:\n\n` +
    `• MoonPay (Card / Apple Pay)\n` +
    `• Transak\n` +
    `• Ramp\n\n` +
    `This will allow you to fund your trading wallet directly inside the bot.\n\n` +
    `🚀 *Coming very soon!*`;

  await ctx.reply(text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("⬅ Return", "MENU_HOME")],
    ]),
  });
});

bot.action("BUY_MIN_MC", async (ctx) => {
  await ctx.answerCbQuery();
  setFlow(ctx.from!.id, "AWAIT_SET_MIN_MC");
  await ctx.reply("Enter minimum market cap (USD). Example: 100000");
});

bot.action("BUY_MAX_MC", async (ctx) => {
  await ctx.answerCbQuery();
  setFlow(ctx.from!.id, "AWAIT_SET_MAX_MC");
  await ctx.reply("Enter maximum market cap.");
});

bot.action("BUY_MIN_LIQ", async (ctx) => {
  await ctx.answerCbQuery();
  setFlow(ctx.from!.id, "AWAIT_SET_MIN_LIQ");
  await ctx.reply("Enter minimum liquidity (USD).");
});

bot.action("BUY_MAX_LIQ", async (ctx) => {
  await ctx.answerCbQuery();
  setFlow(ctx.from!.id, "AWAIT_SET_MAX_LIQ");
  await ctx.reply("Enter maximum liquidity.");
});


bot.action("MENU_BUY", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;

  const u = getUser(userId);
  if (u.wallets.length === 0) {
    await ctx.reply("Tap Wallet first to create your trading wallet.", { ...bonkMainMenu() });
    return;
  }

  setFlow(userId, "AWAIT_BUY_CA");
  await ctx.reply("Please paste the CA");
});

bot.action("MENU_LIMIT_ORDERS", async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from!.id;

  const text = await buildLimitOrdersMiniText(userId);

  await ctx.reply(text, {
    ...limitOrdersMiniKeyboard(userId),
  });
});

bot.action("LO_CLOSE", async (ctx) => {
  await ctx.answerCbQuery();
  await showHomeMenu(ctx, ctx.from!.id);
});

bot.action("LO_REFRESH", async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from!.id;
  const text = await buildLimitOrdersMiniText(userId);

  await ctx.editMessageText(text, {
    ...limitOrdersMiniKeyboard(userId),
  });
});

bot.action(/LO_DELETE_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from!.id;
  const index = Number((ctx.match as any)[1]);

  const u = getUser(userId);

  if (index >= 0 && index < u.sellLimits.length) {
    u.sellLimits.splice(index, 1);
    setUser(u);
  }

  const text = await buildLimitOrdersMiniText(userId);

  await ctx.editMessageText(text, {
    ...limitOrdersMiniKeyboard(userId),
  });
});

bot.action("LO_PREV", async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action("LO_NEXT", async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action("FLOW_CANCEL", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  setFlow(userId, "NONE");
  setDraft(userId, { activeField: "NONE" });
  await ctx.reply("Cancelled.", { ...bonkMainMenu() });
});

/* =========================
   COPYTRADE ACTIONS
========================= */

bot.action("CT_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
`🤖 *Copytrade Help*

Automatically copy the trades of any Solana wallet in real time.

*How it works:*
1️⃣ Tap *Add Wallet* and paste the wallet address you want to follow
2️⃣ Select which of your wallets executes the copied trades
3️⃣ Set your *Copy Size* — how much of the original trade to mirror (e.g. 50% means if they buy 1 SOL worth, you buy 0.5 SOL)
4️⃣ Toggle wallets ON/OFF anytime without removing them

*Buttons explained:*
• *Add Wallet* — add a new wallet to follow
• *Turn All On* — enable copying for all tracked wallets
• *Turn All Off* — pause all copying without deleting wallets
• *100%* — set copy size to match the original trade exactly
• *Custom* — enter your own copy percentage (1–100)
• Wallet buttons (🟢/🔴) — tap to select which of your wallets executes the copy trades

⚠️ Make sure *Allow Auto Buy* is enabled in Buy Settings, otherwise copytrades will be skipped.`,
    { parse_mode: "Markdown" }
  );
});

bot.action("CT_RETURN", async (ctx) => {
  await ctx.answerCbQuery();
  await showHomeMenu(ctx, ctx.from!.id);
});

bot.action("CT_ALL_ON", async (ctx) => {
  await ctx.answerCbQuery();
  turnAllCopytrade(ctx.from!.id, true);
  await showCopytradeMenu(ctx, ctx.from!.id);
});

bot.action("CT_ALL_OFF", async (ctx) => {
  await ctx.answerCbQuery();
  turnAllCopytrade(ctx.from!.id, false);
  await showCopytradeMenu(ctx, ctx.from!.id);
});

bot.action("CT_ADD", async (ctx) => {
  await ctx.answerCbQuery();
  setFlow(ctx.from!.id, "AWAIT_COPYTRADE_WALLET");
  await ctx.reply("Paste the wallet address you want to copytrade.");
});

// CT_ADD_WALLET is the button label used in copytradeKeyboard
bot.action("CT_ADD_WALLET", async (ctx) => {
  await ctx.answerCbQuery();
  setFlow(ctx.from!.id, "AWAIT_COPYTRADE_WALLET");
  await ctx.reply("Paste the wallet address you want to copytrade.");
});

bot.action(/CT_TOGGLE_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = (ctx.match as any)[1] as string;
  toggleCopytradeWallet(ctx.from!.id, id);
  await showCopytradeMenu(ctx, ctx.from!.id);
});

bot.action(/CT_DEL_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = (ctx.match as any)[1] as string;
  removeCopytradeWallet(ctx.from!.id, id);
  await showCopytradeMenu(ctx, ctx.from!.id);
});

bot.action(/CT_SIZE_(\d+)/, async (ctx) => {  

  await ctx.answerCbQuery();

  const userId = ctx.from!.id;
  const percent = Number(ctx.match[1]);

  copytradePercent.set(userId, percent);

  await showCopytradeMenu(ctx, userId);
});

bot.action("CT_SIZE_CUSTOM", async (ctx) => {

  await ctx.answerCbQuery();

  const userId = ctx.from!.id;

  setFlow(userId, "AWAIT_COPY_SIZE");

  await ctx.reply("Enter custom copy percentage (1-100):");
});

/* =========================
   WALLET ACTIONS
========================= */

bot.action(/^W_UP_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from!.id;
  const walletId = (ctx.match as any)[1];

  const u = getUser(userId);
  const index = u.wallets.findIndex((w) => w.id === walletId);

  if (index > 0) {
    const temp = u.wallets[index - 1];
    u.wallets[index - 1] = u.wallets[index];
    u.wallets[index] = temp;
    setUser(u);
  }

  await showWalletMenu(ctx, userId);
});

bot.action(/^W_DOWN_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from!.id;
  const walletId = (ctx.match as any)[1];

  const u = getUser(userId);
  const index = u.wallets.findIndex((w) => w.id === walletId);

  if (index < u.wallets.length - 1) {
    const temp = u.wallets[index + 1];
    u.wallets[index + 1] = u.wallets[index];
    u.wallets[index] = temp;
    setUser(u);
  }

  await showWalletMenu(ctx, userId);
});

bot.action("MENU_WALLET", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const u = getUser(userId);

  if (u.wallets.length === 0) {
    addWallet(userId, "wallet1", Keypair.generate(), true);
  }

  await ctx.reply(await buildWalletsText(userId), {
    parse_mode: "Markdown",
    ...walletsKeyboard(userId),
  });
});

bot.action("W_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
`👛 *Wallet Help*

Your wallets hold your SOL and tokens. You can have multiple wallets.

*Wallet types:*
• 🟢 *Default* — used for all automated trades (copytrade, auto-buy). Only one wallet can be Default at a time
• 🟢 *Manual* — included in manual buys/sells. Multiple wallets can be Manual

*Buttons explained:*
• *Generate Wallet* — creates a new secure wallet instantly
• *Import Wallet* — import an existing wallet using a private key (Base58 or JSON array)
• *⚙️ [wallet name]* — open that wallet to send SOL, rename it, or view its address
• *🟢/🔴 Manual* — toggle whether this wallet participates in manual trades
• *❌* — delete this wallet (cannot delete the Default wallet)
• *🗂 Rearrange* — drag wallets up/down to reorder them

⚠️ Never share your private key with anyone. Your keys are encrypted and stored locally.`,
    { parse_mode: "Markdown" }
  );
});

bot.action("W_RETURN", async (ctx) => {
  await ctx.answerCbQuery();
  await showHomeMenu(ctx, ctx.from!.id);
});

bot.action("W_REARRANGE", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;

  const current = walletReorderMode.get(userId) === true;
  walletReorderMode.set(userId, !current);

  await showWalletMenu(ctx, userId);
});

bot.action("W_DEFAULT_INFO", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const u = getUser(userId);

  if (u.wallets.length === 0) {
    await ctx.answerCbQuery("No wallets to set as default.", { show_alert: true });
    return;
  }

  const rows = u.wallets.map((w) =>
    [Markup.button.callback(
      `${w.isDefault ? "✅" : "⬜"} ${w.name} — ${shortAddr(w.pubkey, 6, 4)}`,
      `W_SET_DEFAULT_${w.id}`
    )]
  );
  rows.push([Markup.button.callback("↩️ Cancel", "W_DEFAULT_CANCEL")]);

  try {
    await ctx.editMessageText(
      `🏦 *Set Default Wallet*\n\nChoose which wallet to use for all automated trades, copytrade, and referral payouts:`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) }
    );
  } catch {
    await ctx.reply(
      `🏦 *Set Default Wallet*\n\nChoose which wallet to make default:`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) }
    );
  }
});

bot.action("W_DEFAULT_CANCEL", async (ctx) => {
  await ctx.answerCbQuery();
  await showWalletMenu(ctx, ctx.from!.id);
});

bot.action("W_REFRESH", async (ctx) => {
  await ctx.answerCbQuery("🔄 Refreshing balances...");
  await showWalletMenu(ctx, ctx.from!.id, true);
});



bot.action("W_GENERATE", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const name = `wallet${getUser(userId).wallets.length + 1}`;
  addWallet(userId, name, Keypair.generate(), false);
  await showWalletMenu(ctx, userId, true);
});

bot.action("W_IMPORT", async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from!.id;

  setFlow(userId, "AWAIT_IMPORT_WALLET_NAME");

  await ctx.reply(
    "🪪 What would you like to call this wallet?\n\nExample: Phantom / Trading / Sniper"
  );
});

bot.action(/^W_TOGMAN_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const walletId = (ctx.match as any)[1] as string;
  toggleManual(userId, walletId);
  await showWalletMenu(ctx, userId);
});

bot.action(/^W_DEL_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const walletId = (ctx.match as any)[1] as string;

  const u = getUser(userId);
  const wallet = u.wallets.find((w) => w.id === walletId);

  if (wallet?.isDefault) {
    await ctx.answerCbQuery("Cannot delete default wallet");
    return;
  }

  deleteWallet(userId, walletId);
  await showWalletMenu(ctx, userId);
});

bot.action(/^W_OPEN_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from!.id;
  const walletId = (ctx.match as any)[1];

  const text = await buildWalletPopupText(walletId, userId);

  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    ...walletPopupKeyboard(walletId),
  });
});

bot.action("WP_RETURN", async (ctx) => {
  await ctx.answerCbQuery();
  await showWalletMenu(ctx, ctx.from!.id);
});

bot.action("WP_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
`⚙️ *Wallet Options Help*

This screen shows details for a single wallet and lets you manage it.

*Buttons explained:*
• *⬆️ Send SOL* — send SOL from this wallet to any Solana address
• *⬆️ Send Tokens* — send any token from this wallet to another address
• *Rename* — give this wallet a custom name (e.g. "Sniper", "Phantom", "Main")

*Status indicators:*
• 🟢 *Default* — this wallet is used for automated trades
• 🔴 *Default* — this wallet is NOT the default
• 🟢 *Manual* — this wallet is included in manual buys/sells
• 🔴 *Manual* — this wallet is excluded from manual trades

💡 To make this wallet the Default, go back to the Wallet list and rearrange or toggle accordingly.`,
    { parse_mode: "Markdown" }
  );
});

bot.action(/^WP_SEND_SOL_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const walletId = (ctx.match as any)[1];
  const userId = ctx.from!.id;

  const u = getUser(userId);
  const wallet = u.wallets.find((w) => w.id === walletId);

  if (!wallet) {
    await ctx.reply("Wallet not found.");
    return;
  }

  await ctx.reply(
    `Send SOL\n\nWallet:\n${wallet.pubkey}\n\nPaste the destination address.`
  );

  setFlow(userId, "AWAIT_SEND_SOL_ADDRESS");
});

bot.action(/^WP_SEND_TOKEN_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const walletId = (ctx.match as any)[1];
  const userId = ctx.from!.id;

  const u = getUser(userId);
  const wallet = u.wallets.find((w) => w.id === walletId);

  if (!wallet) {
    await ctx.reply("Wallet not found.");
    return;
  }

  await ctx.reply(
    `Send Tokens\n\nWallet:\n${wallet.pubkey}\n\nPaste the token mint address.`
  );

  setFlow(userId, "AWAIT_SEND_TOKEN_MINT");
});
/* =========================
   GLOBAL SETTINGS
========================= */

bot.action("MENU_GLOBAL_SETTINGS", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(await buildGlobalSettingsText(ctx.from!.id), {
    parse_mode: "Markdown",
    ...globalSettingsKeyboardBig(ctx.from!.id),
  });
});

bot.action("GS_RETURN", async (ctx) => {
  await ctx.answerCbQuery();
  await showHomeMenu(ctx, ctx.from!.id);
});

bot.action("GS_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
`⚙️ *Global Settings Help*

These settings apply across all your wallets and trading activity.

*Buttons explained:*
• *⚙️ Buy* — configure your buy settings (slippage, gas, auto-buy checks)
• *⚙️ Sell* — configure your sell settings (slippage, gas, auto-sell behaviour)
• *Initial Includes Fees* — when ON, your initial investment amount includes gas fees in PnL calculations
• *Monitor* — switch between Brief (minimal notifications) and Detailed (full trade info) mode
• *Wallet Selection* — Single uses only your Default wallet; Multi uses all Manual wallets simultaneously
• *Anti-MEV* — when ON, routes transactions to protect against MEV sandwich attacks

💡 These are your global defaults. Individual modules like Copytrade can override them with their own settings.`,
    { parse_mode: "Markdown" }
  );
});

bot.action("GS_PRINT", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const u = getUser(userId);
  const on  = (v: boolean) => v ? "\U0001f7e2" : "\U0001f534";

  const limitLines = u.sellLimits.length === 0
    ? "None"
    : "\n" + u.sellLimits.map(o => {
        const type = o.type === "TAKE_PROFIT" ? "TP" : o.type === "STOP_LOSS" ? "SL" : "TSL";
        const pct  = o.type === "STOP_LOSS" ? `${o.percentageChange}%` : `+${Math.abs(o.percentageChange)}%`;
        return `  \u25b8 ${type} | Percentage: ${pct} \u2022 ${o.balancePct}% \u2022 ${o.durationHours}h`;
      }).join("\n");

  const lines = [
    "\U0001f4cb *Settings Snapshot*",
    "",
    "\U0001f4cc *Global*",
    `Anti-MEV: ${on(u.global.antiMev)}`,
    `Initial Includes Fees: ${on(u.global.initialIncludesFees)}`,
    `Monitor: ${u.global.monitorMode === "SIMPLE" ? "Brief" : "Detailed"}`,
    `Wallet Selection: ${u.global.walletSelection === "SINGLE" ? "Single" : "Multi"}`,
    "",
    "\U0001f4cc *Buy*",
    `Auto Buy: ${on(u.buy.allowAutoBuy)}`,
    `Duplicate Buy: ${on(u.buy.duplicateBuy)}`,
    `Buy Gas Price: *${u.buy.gasDeltaSol} SOL*`,
    `Min MarketCap: ${u.buy.checks.minMcEnabled ? `*${u.buy.checks.minMc} USD*` : "Disabled"}`,
    `Max MarketCap: ${u.buy.checks.maxMcEnabled ? `*${u.buy.checks.maxMc} USD*` : "Disabled"}`,
    `Min Liquidity: ${u.buy.checks.minLiquidityEnabled ? `*${u.buy.checks.minLiquidity} USD*` : "Disabled"}`,
    `Max Liquidity: ${u.buy.checks.maxLiquidityEnabled ? `*${u.buy.checks.maxLiquidity} USD*` : "Disabled"}`,
    `Price Impact Alert: Default (*${u.buy.priceImpactPct}%*)`,
    `Slippage: *${u.buy.slippagePct}%*`,
    `Trade Buy Confirmation: ${on(u.buy.confirmManualBuy)}`,
    "",
    "\U0001f4cc *Sell*",
    `Auto Sell on Manual Buy: ${on(u.sell.autoSellOnManualBuy)}`,
    `Auto Sell Retry: ${on(u.sell.autoSellRetry)}`,
    `Auto PnL Card: ${on(u.sell.autoPnlCard)}`,
    `PnL Card Duration: *${u.sell.durationHours}h*`,
    `PnL Card - Inv. & Payout: ${on(u.sell.invAndPayout)}`,
    `Trade Sell Confirmation: ${on(u.sell.confirmManualSell)}`,
    `Sell Gas Price: *${u.sell.gasDeltaSol} SOL*`,
    `Price Impact Alert: Default (*${u.sell.priceImpactPct}%*)`,
    `Slippage: *${u.sell.slippagePct}%*`,
    `Sell Limit Orders: ${limitLines}`,
  ];

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});
bot.action("GS_TOGGLE_ANTIMEV", async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUser(ctx.from!.id);
  u.global.antiMev = !u.global.antiMev;
  setUser(u);
  await showGlobalSettingsMenu(ctx, u.userId);
});

bot.action("GS_TOGGLE_FEES", async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUser(ctx.from!.id);
  u.global.initialIncludesFees = !u.global.initialIncludesFees;
  setUser(u);
  await showGlobalSettingsMenu(ctx, u.userId);
});

bot.action("GS_TOGGLE_MONITOR", async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUser(ctx.from!.id);
  u.global.monitorMode = u.global.monitorMode === "SIMPLE" ? "DETAILED" : "SIMPLE";
  setUser(u);
  await showGlobalSettingsMenu(ctx, u.userId);
});

bot.action("GS_TOGGLE_WALLETSEL", async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUser(ctx.from!.id);
  u.global.walletSelection = u.global.walletSelection === "SINGLE" ? "MULTI" : "SINGLE";
  setUser(u);
  await showGlobalSettingsMenu(ctx, u.userId);
});

bot.action("GS_BUY", async (ctx) => {
  await ctx.answerCbQuery();
  await showBuySettingsMenu(ctx, ctx.from!.id);
});

bot.action("GS_SELL", async (ctx) => {
  await ctx.answerCbQuery();
  await showSellSettingsMenu(ctx, ctx.from!.id);
});

/* =========================
   BUY SETTINGS
========================= */

bot.action("BS_RETURN", async (ctx) => {
  await ctx.answerCbQuery();
  await showGlobalSettingsMenu(ctx, ctx.from!.id);
});

bot.action("BS_PRINT", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const u = getUser(userId);
  const on = (v: boolean) => v ? "\U0001f7e2" : "\U0001f534";

  const lines = [
    "\U0001f4cb *Buy Settings*",
    "",
    `Auto Buy: ${on(u.buy.allowAutoBuy)}`,
    `Duplicate Buy: ${on(u.buy.duplicateBuy)}`,
    `Trade Buy Confirmation: ${on(u.buy.confirmManualBuy)}`,
    `Gas Delta: *${u.buy.gasDeltaSol} SOL*`,
    `Price Impact: *${u.buy.priceImpactPct}%*`,
    `Slippage: *${u.buy.slippagePct}%*`,
    "",
    "\U0001f4cc *Auto Buy Checks*",
    `Min MarketCap: ${u.buy.checks.minMcEnabled ? `*${u.buy.checks.minMc} USD*` : "Disabled"}`,
    `Max MarketCap: ${u.buy.checks.maxMcEnabled ? `*${u.buy.checks.maxMc} USD*` : "Disabled"}`,
    `Min Liquidity: ${u.buy.checks.minLiquidityEnabled ? `*${u.buy.checks.minLiquidity} USD*` : "Disabled"}`,
    `Max Liquidity: ${u.buy.checks.maxLiquidityEnabled ? `*${u.buy.checks.maxLiquidity} USD*` : "Disabled"}`,
  ];

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});
bot.action("BS_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
`🟢 *Buy Settings Help*

Configure how your buys are executed.

*Buttons explained:*
• *Confirm Manual Buy* — when ON, asks you to confirm before executing a manual buy
• *Gas Delta* — extra SOL added on top of the base fee to prioritise your transaction (e.g. 0.005 SOL). Higher = faster confirmation
• *Price Impact* — maximum allowed price impact % before a buy is rejected. Protects against buying into low liquidity pools
• *Slippage* — maximum % difference between expected and actual price you'll accept. Higher = more likely to fill but worse price
• *Allow Auto Buy* — master switch for all automated buys (copytrade, signals). Must be ON for any auto-buy to work
• *Duplicate Buy* — when ON, allows buying a token you already hold. When OFF, skips if you already have a position
• *⚙️ Auto Buy Checks* — set minimum/maximum market cap and liquidity filters for auto-buys`,
    { parse_mode: "Markdown" }
  );
});

bot.action("BS_TOGGLE_CONFIRM_MANUAL", async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUser(ctx.from!.id);
  u.buy.confirmManualBuy = !u.buy.confirmManualBuy;
  setUser(u);
  await showBuySettingsMenu(ctx, u.userId);
});

bot.action("BS_SET_GASDELTA", async (ctx) => {
  await ctx.answerCbQuery();
  setFlow(ctx.from!.id, "AWAIT_SET_BUY_GASDELTA");
  await ctx.reply("Type Buy Gas Delta in SOL (example: 0.005). Type /cancel to abort.");
});

bot.action("BS_SET_PRICEIMPACT", async (ctx) => {
  await ctx.answerCbQuery();
  setFlow(ctx.from!.id, "AWAIT_SET_BUY_PRICEIMPACT");
  await ctx.reply("Type Buy Price Impact % (example: 25). Type /cancel to abort.");
});

bot.action("BS_SET_SLIPPAGE", async (ctx) => {
  await ctx.answerCbQuery();
  setFlow(ctx.from!.id, "AWAIT_SET_BUY_SLIPPAGE");
  await ctx.reply("Type Buy Slippage % (example: 7). Type /cancel to abort.");
});

bot.action("BS_TOGGLE_ALLOW_AUTO", async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUser(ctx.from!.id);
  u.buy.allowAutoBuy = !u.buy.allowAutoBuy;
  setUser(u);
  await showBuySettingsMenu(ctx, u.userId);
});

bot.action("BS_TOGGLE_DUPLICATE_BUY", async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUser(ctx.from!.id);
  u.buy.duplicateBuy = !u.buy.duplicateBuy;
  setUser(u);
  await showBuySettingsMenu(ctx, u.userId);
});

bot.action("BS_AUTO_BUY_CHECKS", async (ctx) => {
  await ctx.answerCbQuery();
  await showAutoBuyChecksMenu(ctx, ctx.from!.id);
});

/* =========================
   AUTO BUY CHECKS
========================= */

bot.action("ABC_RETURN", async (ctx) => {
  await ctx.answerCbQuery();
  await showBuySettingsMenu(ctx, ctx.from!.id);
});

bot.action("ABC_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
`🔍 *Auto Buy Checks Help*

These filters run before every automated buy. If any enabled check fails, the buy is skipped.

*Buttons explained:*
• *Min MC* — minimum market cap in USD. Tokens below this cap will be ignored (e.g. 10000 = $10k min)
• *Max MC* — maximum market cap in USD. Tokens above this cap will be ignored
• *Min Liquidity* — minimum liquidity pool size in USD. Protects against buying into illiquid tokens
• *Max Liquidity* — maximum liquidity pool size in USD

🟢 = check is active and enforced
🔴 = check is disabled (no filter applied)

💡 Tap any button to toggle it. If enabling, you'll be prompted to enter the value.
These checks apply to copytrade and any future auto-buy signals.`,
    { parse_mode: "Markdown" }
  );
});

bot.action("ABC_TOGGLE_MIN_MC", async (ctx) => {
  await ctx.answerCbQuery();

  const u = getUser(ctx.from!.id);

  if (u.buy.checks.minMcEnabled) {
    u.buy.checks.minMcEnabled = false;
    setUser(u);

    await showBuySettingsMenu(ctx, ctx.from!.id);
    return;
  }

  setFlow(ctx.from!.id, "AWAIT_SET_MIN_MC");
  await ctx.reply("Enter minimum market cap.");
});

bot.action("ABC_TOGGLE_MAX_MC", async (ctx) => {
  await ctx.answerCbQuery();

  const u = getUser(ctx.from!.id);

  if (u.buy.checks.maxMcEnabled) {
    u.buy.checks.maxMcEnabled = false;
    setUser(u);
    await showBuySettingsMenu(ctx, ctx.from!.id);
    return;
  }

  setFlow(ctx.from!.id, "AWAIT_SET_MAX_MC");
  await ctx.reply("Enter maximum market cap.");
});

bot.action("ABC_TOGGLE_MIN_LIQ", async (ctx) => {
  await ctx.answerCbQuery();

  const u = getUser(ctx.from!.id);

  if (u.buy.checks.minLiquidityEnabled) {
    u.buy.checks.minLiquidityEnabled = false;
    setUser(u);
    await showBuySettingsMenu(ctx, ctx.from!.id);
    return;
  }

  setFlow(ctx.from!.id, "AWAIT_SET_MIN_LIQ");
  await ctx.reply("Enter minimum liquidity.");
});

bot.action("ABC_TOGGLE_MAX_LIQ", async (ctx) => {
  await ctx.answerCbQuery();

  const u = getUser(ctx.from!.id);

  if (u.buy.checks.maxLiquidityEnabled) {
    u.buy.checks.maxLiquidityEnabled = false;
    setUser(u);
    await showBuySettingsMenu(ctx, ctx.from!.id);
    return;
  }

  setFlow(ctx.from!.id, "AWAIT_SET_MAX_LIQ");
  await ctx.reply("Enter maximum liquidity.");
});

/* =========================
   SELL SETTINGS
========================= */

bot.action("SS_RETURN", async (ctx) => {
  await ctx.answerCbQuery();
  await showGlobalSettingsMenu(ctx, ctx.from!.id);
});

bot.action("SS_PRINT", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const u = getUser(userId);
  const on = (v: boolean) => v ? "\U0001f7e2" : "\U0001f534";

  const limitLines = u.sellLimits.length === 0
    ? "None configured."
    : "\n" + u.sellLimits.map(o => {
        const type = o.type === "TAKE_PROFIT" ? "TP" : o.type === "STOP_LOSS" ? "SL" : "TSL";
        const pct  = o.type === "STOP_LOSS" ? `${o.percentageChange}%` : `+${Math.abs(o.percentageChange)}%`;
        return `  \u25b8 ${type} | Percentage: ${pct} \u2022 ${o.balancePct}% \u2022 ${o.durationHours}h`;
      }).join("\n");

  const lines = [
    "\U0001f4cb *Sell Settings*",
    "",
    `Trade Sell Confirmation: ${on(u.sell.confirmManualSell)}`,
    `Gas Delta: *${u.sell.gasDeltaSol} SOL*`,
    `Price Impact: *${u.sell.priceImpactPct}%*`,
    `Slippage: *${u.sell.slippagePct}%*`,
    `Auto Sell on Manual Buy: ${on(u.sell.autoSellOnManualBuy)}`,
    `Auto Sell Retry: ${on(u.sell.autoSellRetry)}`,
    `Auto PnL Card: ${on(u.sell.autoPnlCard)}`,
    `PnL Card Duration: *${u.sell.durationHours}h*`,
    `Inv. & Payout: ${on(u.sell.invAndPayout)}`,
    "",
    "\U0001f4cc *Sell Limit Orders*",
    limitLines,
  ];

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});
bot.action("SS_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
`🔴 *Sell Settings Help*

Configure how your sells are executed.

*Buttons explained:*
• *Confirm Manual Sell* — when ON, asks you to confirm before executing a manual sell
• *Gas Delta* — extra SOL added on top of base fee to prioritise your sell transaction
• *Price Impact* — maximum allowed price impact % before a sell is rejected
• *Slippage* — maximum % price difference you'll accept on a sell
• *Auto PnL Card* — when ON, automatically sends a PnL summary image after a sell completes
• *Duration* — how long (in hours) to keep monitoring a position for auto-sell triggers
• *Inv. & Payout* — when ON, shows your initial investment and payout amounts on PnL cards
• *Auto Sell on Manual Buy* — when ON, automatically applies your Sell Limit Orders after every manual buy
• *Auto Sell Retry* — when ON, retries failed auto-sells automatically
• *⚙️ Sell Limit* — configure Take Profit, Stop Loss, and Trailing Stop Loss orders`,
    { parse_mode: "Markdown" }
  );
});

bot.action("SS_TOGGLE_CONFIRM_MANUAL", async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUser(ctx.from!.id);
  u.sell.confirmManualSell = !u.sell.confirmManualSell;
  setUser(u);
  await showSellSettingsMenu(ctx, u.userId);
});

bot.action("SS_SET_GASDELTA", async (ctx) => {
  await ctx.answerCbQuery();
  setFlow(ctx.from!.id, "AWAIT_SET_SELL_GASDELTA");
  await ctx.reply("Type Sell Gas Delta in SOL (example: 0.005). Type /cancel to abort.");
});

bot.action("SS_SET_PRICEIMPACT", async (ctx) => {
  await ctx.answerCbQuery();
  setFlow(ctx.from!.id, "AWAIT_SET_SELL_PRICEIMPACT");
  await ctx.reply("Type Sell Price Impact % (example: 50). Type /cancel to abort.");
});

bot.action("SS_SET_SLIPPAGE", async (ctx) => {
  await ctx.answerCbQuery();
  setFlow(ctx.from!.id, "AWAIT_SET_SELL_SLIPPAGE");
  await ctx.reply("Type Sell Slippage % (example: 15). Type /cancel to abort.");
});

bot.action("SS_TOGGLE_AUTOPNL", async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUser(ctx.from!.id);
  u.sell.autoPnlCard = !u.sell.autoPnlCard;
  setUser(u);
  await showSellSettingsMenu(ctx, u.userId);
});

bot.action("SS_SET_DURATION", async (ctx) => {
  await ctx.answerCbQuery();
  setFlow(ctx.from!.id, "AWAIT_SET_SELL_DURATION");
  await ctx.reply("Type Duration in hours (example: 168). Type /cancel to abort.");
});

bot.action("SS_TOGGLE_INV_PAY", async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUser(ctx.from!.id);
  u.sell.invAndPayout = !u.sell.invAndPayout;
  setUser(u);
  await showSellSettingsMenu(ctx, u.userId);
});

bot.action("SS_TOGGLE_AUTOSELL_ON_MANUAL", async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUser(ctx.from!.id);
  u.sell.autoSellOnManualBuy = !u.sell.autoSellOnManualBuy;
  setUser(u);
  await showSellSettingsMenu(ctx, u.userId);
});

bot.action("SS_TOGGLE_AUTOSELL_RETRY", async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUser(ctx.from!.id);
  u.sell.autoSellRetry = !u.sell.autoSellRetry;
  setUser(u);
  await showSellSettingsMenu(ctx, u.userId);
});

bot.action("SS_SELL_LIMIT", async (ctx) => {
  await ctx.answerCbQuery();
  getDraft(ctx.from!.id);
  await showSellLimitsMenu(ctx, ctx.from!.id);
});

/* =========================
   SELL LIMIT ACTIONS
========================= */

bot.action("SL_RETURN", async (ctx) => {
  await ctx.answerCbQuery();
  await showSellSettingsMenu(ctx, ctx.from!.id);
});

bot.action("SL_TYPE_TP", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  setDraft(userId, { type: "TAKE_PROFIT" });
  await showSellLimitsMenu(ctx, userId);
});

bot.action("SL_TYPE_SL", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  setDraft(userId, { type: "STOP_LOSS" });
  await showSellLimitsMenu(ctx, userId);
});

bot.action("SL_TYPE_TSL", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  setDraft(userId, { type: "TRAILING_SL" });
  await showSellLimitsMenu(ctx, userId);
});

bot.action("SL_SET_PCT", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  setDraft(userId, { activeField: "PCT" });
  setFlow(userId, "AWAIT_SET_SL_PCT");
  await ctx.reply(
    "Type Percentage Change (number).\nExamples:\nTake Profit: 50\nStop Loss: 70 (stored as -70)\nTrailing SL: 10\n/cancel to abort."
  );
});

bot.action("SL_SET_BAL", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  setDraft(userId, { activeField: "BAL" });
  setFlow(userId, "AWAIT_SET_SL_BAL");
  await ctx.reply("Type Balance % (1-100). Example: 25\n/cancel to abort.");
});

bot.action("SL_SET_DUR", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  setDraft(userId, { activeField: "DUR" });
  setFlow(userId, "AWAIT_SET_SL_DUR");
  await ctx.reply("Type Duration in hours. Example: 168\n/cancel to abort.");
});

bot.action("SL_ADD", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const u = getUser(userId);
  const d = getDraft(userId);

  if (!Number.isFinite(d.percentageChange) || d.percentageChange <= 0) {
    await ctx.reply("❌ Percentage must be > 0. Tap Percentage Change and type a number.");
    return;
  }
  if (!Number.isFinite(d.balancePct) || d.balancePct < 1 || d.balancePct > 100) {
    await ctx.reply("❌ Balance must be 1-100.");
    return;
  }
  if (!Number.isFinite(d.durationHours) || d.durationHours < 1 || d.durationHours > 24 * 365) {
    await ctx.reply("❌ Duration invalid.");
    return;
  }

  let pctStored = Math.abs(d.percentageChange);
  if (d.type === "STOP_LOSS") pctStored = -pctStored;

  if (u.sellLimits.length >= 10) {
    await ctx.reply("❌ Max 10 sell limit orders.");
    return;
  }

  u.sellLimits.push({
    id: randomId(),
    type: d.type,
    percentageChange: pctStored,
    balancePct: Math.round(d.balancePct),
    durationHours: Math.round(d.durationHours),
    createdAt: new Date().toISOString(),
  });

  setUser(u);
  setDraft(userId, { activeField: "NONE" });

  await showSellLimitsMenu(ctx, userId);
});

bot.action(/SL_DEL_\d+/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const u = getUser(userId);

  const data = (ctx.callbackQuery as any)?.data as string;
  const idx = Number(data.split("_")[2]);
  if (!Number.isFinite(idx) || idx < 0 || idx >= u.sellLimits.length) return;

  u.sellLimits.splice(idx, 1);
  setUser(u);

  await showSellLimitsMenu(ctx, userId);
});

bot.action("SL_CLEAR", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const u = getUser(userId);
  u.sellLimits = [];
  setUser(u);

  await showSellLimitsMenu(ctx, userId);
});

bot.action("NOOP", async (ctx) => {
  await ctx.answerCbQuery();
});

/* =========================
   BUY TOKEN SCREEN ACTIONS
========================= */

bot.action("BT_TRACK", async (ctx) => {
  await ctx.answerCbQuery();
  await showTrackTokenMenu(ctx, ctx.from!.id);
});

bot.action("BT_SOL", async (ctx) => {
  await ctx.answerCbQuery();
  await showBuyTokenMenu(ctx, ctx.from!.id);
});

bot.action("BT_REFRESH", async (ctx) => {
  await ctx.answerCbQuery("🔄 Refreshing...");
  const userId = ctx.from!.id;
  const mint = activeBuyMint.get(userId);
  if (mint) tokenInfoCache.delete(mint);
  await showBuyTokenMenu(ctx, userId);
});

bot.action("BT_GO_SELL", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const mintStr = activeBuyMint.get(userId);
  if (!mintStr) { await ctx.answerCbQuery("No active token"); return; }
  activeSellMint.set(userId, mintStr);
  await showSellTokenMenu(ctx, userId);
});

bot.action("BT_WALLET", async (ctx) => {
  await ctx.answerCbQuery("Wallet picker later");
});

bot.action("BT_TOGGLE_MULTI", async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUser(ctx.from!.id);
  u.global.walletSelection =
    u.global.walletSelection === "SINGLE" ? "MULTI" : "SINGLE";
  setUser(u);
  await showBuyTokenMenu(ctx, u.userId);
});

bot.action("BT_AMT_001", async (ctx) => {
  await ctx.answerCbQuery();
  await executeBuyFromActiveMint(ctx, ctx.from!.id, 0.01);
});

bot.action("BT_AMT_005", async (ctx) => {
  await ctx.answerCbQuery();
  await executeBuyFromActiveMint(ctx, ctx.from!.id, 0.05);
});

bot.action("BT_AMT_03", async (ctx) => {
  await ctx.answerCbQuery();
  await executeBuyFromActiveMint(ctx, ctx.from!.id, 0.3);
});

bot.action("BT_AMT_02", async (ctx) => {
  await ctx.answerCbQuery();
  await executeBuyFromActiveMint(ctx, ctx.from!.id, 0.2);
});

bot.action("BT_AMT_05", async (ctx) => {
  await ctx.answerCbQuery();
  await executeBuyFromActiveMint(ctx, ctx.from!.id, 0.5);
});

bot.action("BT_AMT_1", async (ctx) => {
  await ctx.answerCbQuery();
  await executeBuyFromActiveMint(ctx, ctx.from!.id, 1);
});

bot.action("BT_BUY_X_SOL", async (ctx) => {
  await ctx.answerCbQuery("Custom SOL amount later");
});

bot.action("BT_BUY_X_TOKENS", async (ctx) => {
  await ctx.answerCbQuery("Custom token amount later");
});

bot.action("BT_SHOW_SLIPPAGE", async (ctx) => {
  await ctx.answerCbQuery();
  await showBuyTokenMenu(ctx, ctx.from!.id);
});

bot.action("BT_SHOW_GAS", async (ctx) => {
  await ctx.answerCbQuery();
  await showBuyTokenMenu(ctx, ctx.from!.id);
});

bot.action("BT_BUY_LIMIT", async (ctx) => {
  await ctx.answerCbQuery();
  await showBuyLimitMenu(ctx, ctx.from!.id);
});

/* =========================
   BUY LIMIT SCREEN ACTIONS
========================= */

bot.action("BL_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
`📈 *Buy Limit Orders Help*

Set automatic buys that trigger when a token hits your target price or market cap.

*Buttons explained:*
• *Multi Buy* — when ON, places multiple buy orders as price moves. When OFF, buys once and cancels
• *Price* — trigger the buy when the token hits a specific price
• *MC* — trigger the buy when the token hits a specific market cap
• *Amount* — how much SOL to spend when the order triggers
• *Duration* — how long to keep the order active before it expires (in hours)
• *Add Buy Limit Order* — save the order and start monitoring

💡 Make sure you have a token CA selected before setting buy limits.
⚠️ Buy limit execution requires the bot to be running continuously.`,
    { parse_mode: "Markdown" }
  );
});

bot.action("BL_RETURN", async (ctx) => {
  await ctx.answerCbQuery();
  await showBuyTokenMenu(ctx, ctx.from!.id);
});

bot.action("BL_TOGGLE_MULTI_BUY", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const d = getBuyLimitDraft(userId);
  setBuyLimitDraft(userId, { multiBuy: !d.multiBuy });
  await showBuyLimitMenu(ctx, userId);
});

bot.action("BL_TRIGGER_PRICE", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  setBuyLimitDraft(userId, { triggerType: "PRICE" });
  await showBuyLimitMenu(ctx, userId);
});

bot.action("BL_TRIGGER_MC", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  setBuyLimitDraft(userId, { triggerType: "MC" });
  await showBuyLimitMenu(ctx, userId);
});

bot.action("BL_SET_AMOUNT", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const d = getBuyLimitDraft(userId);
  const next = d.amountSol === 1 ? 0.5 : d.amountSol === 0.5 ? 0.1 : 1;
  setBuyLimitDraft(userId, { amountSol: next });
  await showBuyLimitMenu(ctx, userId);
});

bot.action("BL_SET_DURATION", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const d = getBuyLimitDraft(userId);
  const next = d.durationHours === 168 ? 72 : d.durationHours === 72 ? 24 : 168;
  setBuyLimitDraft(userId, { durationHours: next });
  await showBuyLimitMenu(ctx, userId);
});

bot.action("BL_ADD", async (ctx) => {
  await ctx.answerCbQuery("Buy limit storage later");
  await showBuyLimitMenu(ctx, ctx.from!.id);
});

/* =========================
   TRACK SCREEN ACTIONS
========================= */

bot.action("TR_BACK", async (ctx) => {
  await ctx.answerCbQuery();
  await showBuyTokenMenu(ctx, ctx.from!.id);
});

bot.action("TR_REFRESH", async (ctx) => {
  await ctx.answerCbQuery();
  await showTrackTokenMenu(ctx, ctx.from!.id);
});

bot.action("TR_COPY_CA", async (ctx) => {
  await ctx.answerCbQuery("Copy the CA from the message text above");
});

bot.action("TR_GO_BUY", async (ctx) => {
  await ctx.answerCbQuery();
  await showBuyTokenMenu(ctx, ctx.from!.id);
});

bot.action("TR_TOGGLE_MULTI", async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUser(ctx.from!.id);
  u.global.walletSelection =
    u.global.walletSelection === "SINGLE" ? "MULTI" : "SINGLE";
  setUser(u);
  await showTrackTokenMenu(ctx, u.userId);
});

bot.action("TR_DELETE", async (ctx) => {
  await ctx.answerCbQuery();
  activeBuyMint.delete(ctx.from!.id);
  await showHomeMenu(ctx, ctx.from!.id);
});

bot.action("TR_SELL_LIMIT", async (ctx) => {
  await ctx.answerCbQuery();
  getDraft(ctx.from!.id);
  await showSellLimitsMenu(ctx, ctx.from!.id);
});

/* =========================
   POSITIONS ACTIONS
========================= */

bot.action("POS_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
`📦 *Positions Help*

Track tokens you are currently holding across your wallets.

*Buttons explained:*
• *📈 Add Position* — manually add a token to track by pasting its contract address
• *🔄 Refresh* — reload all position data and balances
• *Wallet buttons* — switch between wallets to view positions for each one
• *Reset* — resets the entry price of a position to its current value (useful to recalculate PnL from now)

*Position info shown:*
• Entry price — the price or value when you opened the position
• Worth — current estimated value
• PnL — profit or loss percentage since entry

💡 Positions are tracked manually. For automatic position tracking, buys executed through the bot are logged automatically.`,
    { parse_mode: "Markdown" }
  );
});

bot.action("POS_RETURN", async (ctx) => {
  await ctx.answerCbQuery();
  await showHomeMenu(ctx, ctx.from!.id);
});



bot.action("POS_REFRESH", async (ctx) => {
  await ctx.answerCbQuery();
  await showPositionsMenu(ctx, ctx.from!.id);
});

bot.action(/POS_WALLET_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from!.id;
  const walletName = ctx.match[1];

  selectedPositionWallet.set(userId, walletName);

  await showPositionsMenu(ctx, userId);
});

bot.action(/CT_WALLET_(.+)/, async (ctx) => {

  await ctx.answerCbQuery();

  const userId = ctx.from!.id;
  const walletName = ctx.match[1];

  selectedCopytradeWallet.set(userId, walletName);

  await ctx.reply(`✅ Copytrade wallet set to: ${walletName}`);

  await showCopytradeMenu(ctx, userId);
});

bot.action("WALLET_RENAME", async (ctx) => {

  await ctx.answerCbQuery();

  const userId = ctx.from!.id;

  setFlow(userId, "AWAIT_RENAME_WALLET");

  await ctx.reply("✏️ Send the new wallet name.");

});

bot.action("HELP_WALLET", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
`👛 *Wallet Help*

Your wallets are used to hold SOL and tokens for trading.

*🟢 Default wallet*
Used for all automated trades — copytrade, auto-buy, auto-sell.
Only one wallet can be Default at a time.

*🟢 Manual wallet*
Included when you manually buy or sell.
Multiple wallets can be Manual simultaneously.

*What you can do:*
• *Generate* a fresh wallet with one tap
• *Import* any existing wallet via private key
• *Send SOL* directly from within the bot
• *Send Tokens* to any Solana address
• *Rename* wallets for easy identification
• *Rearrange* the order wallets appear in

⚠️ Your private keys are AES-256 encrypted and stored locally. Never share them with anyone.`,
    { parse_mode: "Markdown" }
  );
});

/* =========================
   QUICK BUY / QUICK SELL
========================= */

bot.action("MENU_QUICKBUY", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;

  const u = getUser(userId);
  if (u.wallets.length === 0) {
    await ctx.reply("Tap Wallet first to create your trading wallet.", { ...bonkMainMenu() });
    return;
  }

  setFlow(userId, "AWAIT_BUY_CA");
  await ctx.reply("Please paste the CA");
});

bot.action("MENU_QUICKSELL", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;

  const u = getUser(userId);
  if (u.wallets.length === 0) {
    await ctx.reply("Tap Wallet first to create your trading wallet.", { ...bonkMainMenu() });
    return;
  }

  setFlow(userId, "AWAIT_SELL_CA");
  await ctx.reply("Please paste the CA");
});

/* =========================
   SELL TOKEN SCREEN
========================= */

const activeSellMint = new Map<number, string>();

function sellTokenKeyboard(userId: number) {
  const u = getUser(userId);
  const isMulti = u.global.walletSelection === "MULTI";
  const def = getDefaultWallet(userId);
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🔄 Refresh", "ST_REFRESH"),
      Markup.button.callback("📊 Sell Limits", "ST_SELL_LIMITS"),
      Markup.button.callback("↩️ Buy", "ST_RETURN"),
    ],
    [
      Markup.button.callback(`💳 ${def?.name ?? "wallet"}`, "ST_WALLET"),
      Markup.button.callback(isMulti ? "🔴 Multi" : "⬜ Multi", "ST_TOGGLE_MULTI"),
    ],
    [
      Markup.button.callback("25%", "ST_PCT_25"),
      Markup.button.callback("50%", "ST_PCT_50"),
      Markup.button.callback("100%", "ST_PCT_100"),
    ],
    [
      Markup.button.callback("Sell X%", "ST_SELL_X_PCT"),
    ],
    [
      Markup.button.callback(`ⓑ Slippage | ${u.sell.slippagePct}%`, "ST_SLIPPAGE"),
      Markup.button.callback(`ⓑ Gas | ${u.sell.gasDeltaSol} SOL`, "ST_GAS"),
    ],
  ]);
}

async function buildSellTokenText(userId: number) {
  const mint = activeSellMint.get(userId);
  const u = getUser(userId);
  const def = getDefaultWallet(userId);

  if (!mint || !def) {
    return `🔗 *SOL*\n\nNo active token selected.\nPaste a CA first.`;
  }

  const [holding, info] = await Promise.all([
    getTokenHolding(new PublicKey(def.pubkey), new PublicKey(mint)).catch(() => null),
    fetchTokenInfo(mint).catch(() => null),
  ]);

  const mcStr  = info ? fmtUsd(info.mc)       : "Unknown";
  const prStr  = info ? fmtPrice(info.price)   : "Unknown";
  const liqStr = info ? fmtUsd(info.liquidity) : "Unknown";
  const name   = info ? `${info.name} (${info.symbol})` : shortAddr(mint, 12, 8);
  const bal    = holding?.uiAmount ?? 0;

  // PnL line
  const pos = (u.positions ?? []).find((p: any) => p.mint === mint && p.wallet === def.name);
  let pnlLine = "";
  if (pos && pos.entry > 0 && info && bal > 0) {
    const currentValueSol = bal * info.priceSOL;
    const pnlPct = ((currentValueSol - pos.entry) / pos.entry) * 100;
    const sign = pnlPct >= 0 ? "+" : "";
    pnlLine = `\n📊 PnL: *${sign}${pnlPct.toFixed(2)}%* | Entry: ${pos.entry.toFixed(4)} SOL`;
  }

  return (
    `🌕 *${name}*  🔗 *SOL*\n` +
    `\`${mint}\`\n\n` +
    `🗳 MC *${mcStr}* | 💵 Price *${prStr}*\n` +
    `💧 Liquidity *${liqStr}*\n` +
    `🕒 Live prices via DexScreener\n\n` +
    `💼 Balance: *${bal.toLocaleString()} ${info?.symbol ?? ""}*` +
    pnlLine + `\n\n` +
    `💰 *${def.name}* | Slippage: ${u.sell.slippagePct}% | Gas: ${u.sell.gasDeltaSol} SOL`
  );
}

async function showSellTokenMenu(ctx: any, userId: number) {
  const text = await buildSellTokenText(userId);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...sellTokenKeyboard(userId),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "Markdown",
      ...sellTokenKeyboard(userId),
    });
  }
}

async function executeSellFromActiveMint(ctx: any, userId: number, pct: number) {
  const mintStr = activeSellMint.get(userId);
  if (!mintStr) { await ctx.reply("❌ No active sell token."); return; }
  const u = getUser(userId);
  const def = getDefaultWallet(userId);
  if (!def) { await ctx.reply("No wallet found."); return; }

  const mint = new PublicKey(mintStr);
  const loading = await ctx.reply(`⏳ Selling ${pct}%...`);

  try {
    const holding = await getTokenHolding(new PublicKey(def.pubkey), mint);
    if (!holding) throw new Error("No token account found.");
    const totalRaw = BigInt(holding.amountRaw);
    if (totalRaw <= 0n) throw new Error("Token balance is 0.");
    const sellRaw = (totalRaw * BigInt(pct)) / 100n;
    if (sellRaw <= 0n) throw new Error("Sell amount too small.");

    const userKp = loadWalletKeypair(def);
    const quote = await jupiterQuote({
      inputMint: mintStr,
      outputMint: WSOL_MINT,
      amount: sellRaw.toString(),
      slippageBps: slippageBpsFromPct(u.sell.slippagePct),
    });
    const swap = await jupiterSwap({ userPublicKey: def.pubkey, quoteResponse: quote });
    const swapTxB64 = (swap as any)?.swapTransaction;
    if (!swapTxB64) throw new Error("No swapTransaction returned.");
    const sig = await signAndSendSwapTx(userKp, swapTxB64);

    const solReceived = Number(quote.outAmount ?? 0) / LAMPORTS_PER_SOL;
    collectFee(userKp, solReceived, userId, "SELL").catch(() => {});

    await ctx.telegram.editMessageText(
      loading.chat.id, loading.message_id, undefined,
      `✅ *Sold ${pct}%*\n\nMint:\n\`${mintStr}\`\nReceived: *${solReceived.toFixed(4)} SOL*\n\n🧾 Tx:\n\`${sig}\``,
      { parse_mode: "Markdown" }
    );

    // Auto PnL card
    if (u.sell.autoPnlCard) {
      try {
        const entryPos = (u.positions ?? []).find((p: any) => p.mint === mintStr);
        const entrySol = entryPos?.entry || solReceived;
        const pnlSol = solReceived - entrySol;
        const pnlPct = entrySol > 0 ? ((solReceived - entrySol) / entrySol) * 100 : 0;
        const info = await fetchTokenInfo(mintStr).catch(() => null);
        const username = ctx.from?.username ?? `User${userId}`;
        const png = await renderPnlCardPng({
          username,
          mintShort: info ? `${info.name} (${info.symbol})` : shortAddr(mintStr, 6, 4),
          heldFor: entryPos?.createdAt
            ? (() => { const ms = Date.now() - (entryPos.createdAt as number); const h = Math.floor(ms/3600000); const m = Math.floor((ms%3600000)/60000); return h > 0 ? `${h}h ${m}m` : `${m}m`; })()
            : "Unknown",
          pnlPct, pnlSol, valueSol: solReceived, costSol: entrySol,
        });
        await ctx.replyWithPhoto(
          { source: png },
          { caption: `${pnlPct >= 0 ? "📈" : "📉"} *${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%* on ${info?.symbol ?? "token"} — traded on @SolPilotBot`, parse_mode: "Markdown" }
        );
      } catch {}
    }
  } catch (e: any) {
    await ctx.telegram.editMessageText(
      loading.chat.id, loading.message_id, undefined,
      `❌ Sell failed:\n${e?.message ?? String(e)}`
    );
  }
}

// Sell Token Screen Actions
bot.action("ST_REFRESH", async (ctx) => {
  await ctx.answerCbQuery("🔄 Refreshing...");
  const userId = ctx.from!.id;
  const mint = activeSellMint.get(userId);
  if (mint) tokenInfoCache.delete(mint);
  await showSellTokenMenu(ctx, userId);
});

bot.action("ST_RETURN", async (ctx) => {
  await ctx.answerCbQuery();
  await showBuyTokenMenu(ctx, ctx.from!.id);
});

bot.action("ST_WALLET", async (ctx) => {
  await ctx.answerCbQuery("Wallet switching coming soon");
});

bot.action("ST_TOGGLE_MULTI", async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUser(ctx.from!.id);
  u.global.walletSelection = u.global.walletSelection === "SINGLE" ? "MULTI" : "SINGLE";
  setUser(u);
  await showSellTokenMenu(ctx, u.userId);
});

bot.action("ST_PCT_25",  async (ctx) => { await ctx.answerCbQuery(); await executeSellFromActiveMint(ctx, ctx.from!.id, 25);  });
bot.action("ST_PCT_50",  async (ctx) => { await ctx.answerCbQuery(); await executeSellFromActiveMint(ctx, ctx.from!.id, 50);  });
bot.action("ST_PCT_100", async (ctx) => { await ctx.answerCbQuery(); await executeSellFromActiveMint(ctx, ctx.from!.id, 100); });

bot.action("ST_SELL_X_PCT", async (ctx) => {
  await ctx.answerCbQuery();
  setFlow(ctx.from!.id, "AWAIT_SELL_X_PCT" as any);
  await ctx.reply("Enter the percentage to sell (1-100):");
});

bot.action("ST_SELL_LIMITS", async (ctx) => {
  await ctx.answerCbQuery();
  await showSellLimitsMenu(ctx, ctx.from!.id);
});

bot.action("ST_SLIPPAGE", async (ctx) => {
  await ctx.answerCbQuery();
  setFlow(ctx.from!.id, "AWAIT_SET_SELL_SLIPPAGE");
  await ctx.reply("Enter new sell slippage % (e.g. 15):");
});

bot.action("ST_GAS", async (ctx) => {
  await ctx.answerCbQuery();
  setFlow(ctx.from!.id, "AWAIT_SET_SELL_GASDELTA");
  await ctx.reply("Enter new sell gas delta in SOL (e.g. 0.005):");
});

/* =========================
   SELL BUTTONS
========================= */

function sellPercentButtons(mint: string) {
  const pcts = [25, 50, 100];
  const rows = [
    pcts.map((p) => Markup.button.callback(`${p}%`, `SELL_${mint}_${p}`)),
    [
      Markup.button.callback("🔄 Refresh", `SELL_REFRESH_${mint}`),
      Markup.button.callback("❌ Cancel", "FLOW_CANCEL"),
    ],
  ];
  return Markup.inlineKeyboard(rows);
}

const pendingExport = new Map<number, string>();

// ── single catch-all bot.on("callback_query") ──
bot.on("callback_query", async (ctx) => {
  const data = (ctx.callbackQuery as any)?.data as string | undefined;
  if (!data) return;

  if (data.startsWith("W_SET_DEFAULT_")) {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id;
    const walletId = data.replace("W_SET_DEFAULT_", "");
    const u = getUser(userId);
    const target = u.wallets.find((w) => w.id === walletId);
    if (!target) { await ctx.answerCbQuery("Wallet not found.", { show_alert: true }); return; }
    u.wallets = u.wallets.map((w) => ({ ...w, isDefault: w.id === walletId }));
    setUser(u);
    await ctx.answerCbQuery(`✅ ${target.name} is now your default wallet.`, { show_alert: true });
    await showWalletMenu(ctx, userId);
    return;
  }

  if (data === "WP_EXPORT_CONFIRM") {
    await ctx.answerCbQuery();
    const walletId = pendingExport.get(ctx.from!.id);
    if (!walletId) { await ctx.reply("❌ Session expired. Try again."); return; }
    pendingExport.delete(ctx.from!.id);
    const u = getUser(ctx.from!.id);
    const wallet = u.wallets.find((w: any) => w.id === walletId || w.name === walletId || w.pubkey === walletId);
    if (!wallet) { await ctx.reply("❌ Wallet not found."); return; }
    try {
      const kp = loadWalletKeypair(wallet);
      const base58Key = bs58.encode(kp.secretKey);
      try { await ctx.deleteMessage(); } catch {}
      await ctx.reply(`🔑 *Private Key for ${wallet.name ?? "wallet"}*\n\n\`${base58Key}\`\n\n⚠️ *Delete this message after copying.*`, { parse_mode: "Markdown" });
    } catch (e: any) { await ctx.reply(`❌ Could not export key: ${e?.message ?? String(e)}`); }
    return;
  }

  if (data === "WP_EXPORT_CANCEL") {
    await ctx.answerCbQuery("Cancelled.");
    pendingExport.delete(ctx.from!.id);
    try { await ctx.deleteMessage(); } catch {}
    return;
  }

  if (data.startsWith("WP_EXPORT_")) {
    await ctx.answerCbQuery();
    const walletId = data.replace("WP_EXPORT_", "");
    console.log(`🔑 Export triggered: walletId=${walletId}, userId=${ctx.from!.id}`);
    const u = getUser(ctx.from!.id);
    console.log(`🔑 Wallets: ${u.wallets.map((w: any) => `id=${w.id} name=${w.name}`).join(", ")}`);
    const wallet = u.wallets.find((w: any) => w.id === walletId || w.name === walletId || w.pubkey === walletId);
    if (!wallet) { await ctx.reply("❌ Wallet not found."); return; }
    pendingExport.set(ctx.from!.id, walletId);
    await ctx.reply(
      `⚠️ *Export Private Key*\n\nYou are about to reveal the private key for *${wallet.name ?? "this wallet"}*.\n\n*Never share this with anyone.*\n\nTap confirm to reveal your key.`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Confirm — Show Key", "WP_EXPORT_CONFIRM")],
        [Markup.button.callback("❌ Cancel", "WP_EXPORT_CANCEL")],
      ])}
    );
    return;
  }

  if (data === "FLOW_CANCEL") {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id;
    setFlow(userId, "NONE");
    return;
  }

  if (data.startsWith("SELL_REFRESH_")) {
    await ctx.answerCbQuery("🔄 Refreshing...");
    const userId = ctx.from!.id;
    const mintStr = data.replace("SELL_REFRESH_", "");
    const def = getDefaultWallet(userId);
    if (!def) return;

    try {
      const mint = new PublicKey(mintStr);
      const owner = new PublicKey(def.pubkey);
      const holding = await getTokenHolding(owner, mint);
      const info = await fetchTokenInfo(mintStr).catch(() => null);

      if (!holding || BigInt(holding.amountRaw) <= 0n) {
        await ctx.editMessageText(
          `✅ CA: \`${mintStr}\`\n\n❌ You have 0 of this token.`,
          { parse_mode: "Markdown", ...bonkMainMenu() }
        );
        return;
      }

      await ctx.editMessageText(
        `✅ CA: \`${mintStr}\`\n\n${info ? `*${info.name} (${info.symbol})*\nPrice: *${fmtPrice(info.price)}* | MC: *${fmtUsd(info.mc)}*\n\n` : ""}Your balance: *${holding.uiAmount.toLocaleString()}*\nChoose how much to sell:`,
        { parse_mode: "Markdown", ...sellPercentButtons(mintStr) }
      );
    } catch (e: any) {
      await ctx.answerCbQuery("Failed to refresh");
    }
    return;
  }

  if (data.startsWith("SELL_")) {
    await ctx.answerCbQuery();

    const userId = ctx.from!.id;
    const u = getUser(userId);
    const def = getDefaultWallet(userId);
    if (!def) {
      await ctx.reply("Tap Wallet first to create your trading wallet.", { ...bonkMainMenu() });
      return;
    }

    const parts = data.split("_");
    if (parts.length < 3) return;

    const mintStr = parts[1];
    const pct = Number(parts[2]);

    let mint: PublicKey;
    try {
      mint = new PublicKey(mintStr);
    } catch {
      await ctx.reply("❌ Invalid mint.", { ...bonkMainMenu() });
      return;
    }

    if (![25, 50, 100].includes(pct)) {
      await ctx.reply("❌ Invalid sell %.", { ...bonkMainMenu() });
      return;
    }

    const loading = await ctx.reply(`⏳ Selling ${pct}%...`);

    try {
      const owner = new PublicKey(def.pubkey);

      const holding = await getTokenHolding(owner, mint);
      if (!holding) throw new Error("No token account found for this mint.");
      const totalRaw = BigInt(holding.amountRaw);
      if (totalRaw <= 0n) throw new Error("Token balance is 0.");

      const sellRaw = (totalRaw * BigInt(pct)) / 100n;
      if (sellRaw <= 0n) throw new Error("Sell amount too small.");

      const userKp = loadWalletKeypair(def);

      const quote = await jupiterQuote({
        inputMint: mint.toBase58(),
        outputMint: WSOL_MINT,
        amount: sellRaw.toString(),
        slippageBps: slippageBpsFromPct(u.sell.slippagePct),
      });

      const swap = await jupiterSwap({
        userPublicKey: def.pubkey,
        quoteResponse: quote,
      });

      const swapTxB64 = (swap as any)?.swapTransaction;
      if (!swapTxB64) throw new Error("No swapTransaction returned from Jupiter.");

      const sig = await signAndSendSwapTx(userKp, swapTxB64);

      // Collect 1% fee on SOL received
      const solReceived = Number(quote.outAmount ?? 0) / LAMPORTS_PER_SOL;
      const feeKpSell = loadWalletKeypair(def);
      collectFee(feeKpSell, solReceived, userId, "SELL").catch(() => {});

      const out =
        `✅ *Sold*\n\nMint:\n\`${mint.toBase58()}\`\n\n` +
        `Sold: *${pct}%*\n` +
        `Slippage: *${u.sell.slippagePct.toFixed(2)}%*\n\n` +
        `🧾 Tx:\n\`${sig}\``;

      await ctx.telegram.editMessageText(
        loading.chat.id,
        loading.message_id,
        undefined,
        out,
        { parse_mode: "Markdown" }
      );

      // Auto-generate PnL card if enabled
      if (u.sell.autoPnlCard) {
        try {
          const solReceived = Number(quote.outAmount ?? 0) / LAMPORTS_PER_SOL;
          const entryPos = (u.positions ?? []).find((p: any) => p.mint === mint.toBase58());
          const entrySol = entryPos?.entry || solReceived;
          const pnlSol = solReceived - entrySol;
          const pnlPct = entrySol > 0 ? ((solReceived - entrySol) / entrySol) * 100 : 0;
          const info = await fetchTokenInfo(mint.toBase58()).catch(() => null);
          const username = ctx.from?.username ?? `User${userId}`;

          const png = await renderPnlCardPng({
            username,
            mintShort: info ? `${info.name} (${info.symbol})` : shortAddr(mint.toBase58(), 6, 4),
            heldFor: entryPos?.createdAt
              ? (() => {
                  const ms = Date.now() - (entryPos.createdAt as number);
                  const h = Math.floor(ms / 3600000);
                  const m = Math.floor((ms % 3600000) / 60000);
                  return h > 0 ? `${h}h ${m}m` : `${m}m`;
                })()
              : "Unknown",
            pnlPct,
            pnlSol,
            valueSol: solReceived,
            costSol: entrySol,
          });

          await ctx.replyWithPhoto(
            { source: png },
            { caption: `${pnlPct >= 0 ? "📈" : "📉"} *${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%* on ${info?.symbol ?? "token"} — traded on @SolPilotBot`, parse_mode: "Markdown" }
          );
        } catch (pnlErr) {
          console.error("PnL card generation failed:", pnlErr);
        }
      }
    } catch (e: any) {
      console.error("Sell error:", e);
      await ctx.telegram.editMessageText(
        loading.chat.id,
        loading.message_id,
        undefined,
        `❌ Sell failed:\n${e?.message ?? String(e)}`
      );
    }
    return;
  }
});

/* =========================
   FLOW STATE + TEXT HANDLER
========================= */

type Flow =
  | "NONE"
  | "AWAIT_BUY_CA"
  | "AWAIT_SELL_CA"
  | "AWAIT_SELL_X_PCT"
  | "AWAIT_SET_BUY_SLIPPAGE"
  | "AWAIT_SET_BUY_GASDELTA"
  | "AWAIT_SET_BUY_PRICEIMPACT"
  | "AWAIT_SET_SELL_SLIPPAGE"
  | "AWAIT_SET_SELL_GASDELTA"
  | "AWAIT_SET_SELL_PRICEIMPACT"
  | "AWAIT_SET_SELL_DURATION"
  | "AWAIT_SET_SL_PCT"
  | "AWAIT_SET_SL_BAL"
  | "AWAIT_SET_SL_DUR"
  | "AWAIT_COPYTRADE_WALLET"
  | "AWAIT_SEND_SOL_ADDRESS"
  | "AWAIT_SEND_SOL_AMOUNT"
  | "AWAIT_SEND_TOKEN_MINT"
  | "AWAIT_IMPORT_WALLET"
  | "AWAIT_IMPORT_WALLET_NAME"
  | "AWAIT_IMPORT_WALLET_KEY"
  | "AWAIT_SET_MIN_MC"
  | "AWAIT_SET_MAX_MC"
  | "AWAIT_SET_MIN_LIQ"
  | "AWAIT_SET_MAX_LIQ"
  | "AWAIT_POSITION_CA"
  | "AWAIT_RENAME_WALLET"
  | "AWAIT_COPY_SIZE";

const userFlow = new Map<number, Flow>();
const selectedPositionWallet = new Map<number, string>();
const selectedCopytradeWallet = new Map<number, string>();
const copytradePercent = new Map<number, number>();

function setFlow(userId: number, f: Flow) {
  userFlow.set(userId, f);
}

function getFlow(userId: number): Flow {
  return userFlow.get(userId) ?? "NONE";
}

bot.on("text", async (ctx, next) => {
  const userId = ctx.from!.id;
  const flow: Flow = getFlow(userId);
  const txt = ctx.message.text.trim();

  if (txt === "/cancel") {
    setFlow(userId, "NONE");
    setDraft(userId, { activeField: "NONE" });
    await ctx.reply("Cancelled.", { ...bonkMainMenu() });
    return;
  }

  const u = getUser(userId);

  if (flow === "AWAIT_COPYTRADE_WALLET") {
    let pk: PublicKey;
    try {
      pk = new PublicKey(txt);
    } catch {
      await ctx.reply("❌ Invalid wallet address. Paste again or type /cancel.");
      return;
    }
    

    const added = addCopytradeWallet(userId, pk.toBase58());
    if (added) {
  addWalletFollower(pk.toBase58(), userId);
}
    setFlow(userId, "NONE");


    if (!added) {
      await ctx.reply("That wallet is already in your copytrade list.");
    }

    await ctx.reply(await buildCopytradeText(userId), {
      parse_mode: "Markdown",
      ...copytradeKeyboard(userId),
    });
    return;
  }

  if (flow === "AWAIT_COPY_SIZE") {
    const percent = Number(txt);
    if (isNaN(percent) || percent <= 0 || percent > 100) {
      await ctx.reply("❌ Enter a number between 1 and 100.");
      return;
    }
    copytradePercent.set(userId, percent);
    setFlow(userId, "NONE");
    await ctx.reply(`✅ Copy size set to ${percent}%`);
    await showCopytradeMenu(ctx, userId);
    return;
  }

  if (flow === "AWAIT_RENAME_WALLET") {
    const newName = txt;
    const selected = selectedPositionWallet.get(userId) || getDefaultWallet(userId)?.name;
    const wallet = u.wallets.find(w => w.name === selected);
    if (!wallet) { await ctx.reply("❌ Wallet not found."); return; }
    wallet.name = newName;
    setUser(u);
    setFlow(userId, "NONE");
    await ctx.reply(`✅ Wallet renamed to ${newName}`);
    await showWalletMenu(ctx, userId);
    return;
  }

  if (flow === "AWAIT_SET_MIN_MC") {
    const v = Number(txt);
    if (isNaN(v) || v < 0) { await ctx.reply("❌ Enter a valid number."); return; }
    u.buy.checks.minMc = v;
    u.buy.checks.minMcEnabled = true;
    setUser(u);
    setFlow(userId, "NONE");
    await ctx.reply(await buildBuySettingsText(userId), { parse_mode: "Markdown", ...buySettingsKeyboardBig(userId) });
    return;
  }

  if (flow === "AWAIT_SET_MAX_MC") {
    const v = Number(txt);
    if (isNaN(v) || v < 0) { await ctx.reply("❌ Enter a valid number."); return; }
    u.buy.checks.maxMc = v;
    u.buy.checks.maxMcEnabled = true;
    setUser(u);
    setFlow(userId, "NONE");
    await ctx.reply(await buildBuySettingsText(userId), { parse_mode: "Markdown", ...buySettingsKeyboardBig(userId) });
    return;
  }

  if (flow === "AWAIT_SET_MIN_LIQ") {
    const v = Number(txt);
    if (isNaN(v) || v < 0) { await ctx.reply("❌ Enter a valid number."); return; }
    u.buy.checks.minLiquidity = v;
    u.buy.checks.minLiquidityEnabled = true;
    setUser(u);
    setFlow(userId, "NONE");
    await ctx.reply(await buildBuySettingsText(userId), { parse_mode: "Markdown", ...buySettingsKeyboardBig(userId) });
    return;
  }

  if (flow === "AWAIT_SET_MAX_LIQ") {
    const v = Number(txt);
    if (isNaN(v) || v < 0) { await ctx.reply("❌ Enter a valid number."); return; }
    u.buy.checks.maxLiquidity = v;
    u.buy.checks.maxLiquidityEnabled = true;
    setUser(u);
    setFlow(userId, "NONE");
    await ctx.reply(await buildBuySettingsText(userId), { parse_mode: "Markdown", ...buySettingsKeyboardBig(userId) });
    return;
  }

  if (flow === "AWAIT_POSITION_CA") {
    try { new PublicKey(txt); } catch { await ctx.reply("❌ Invalid contract address."); return; }
    if (!u.positions) u.positions = [];
    const wallet = selectedPositionWallet.get(userId) || getDefaultWallet(userId)?.name || "wallet1";
    u.positions.push({ wallet, mint: txt, entry: 0, amount: 0, createdAt: Date.now() });
    setUser(u);
    setFlow(userId, "NONE");
    await ctx.reply("✅ Position added.");
    await showPositionsMenu(ctx, userId);
    return;
  }

  if (flow === "AWAIT_SET_BUY_SLIPPAGE") {
    const v = Number(txt);
    if (!Number.isFinite(v) || v < 0.1 || v > 50) {
      await ctx.reply("Invalid. Example: 7");
      return;
    }
    u.buy.slippagePct = Number(v.toFixed(2));
    setUser(u);
    setFlow(userId, "NONE");
    await ctx.reply(await buildBuySettingsText(userId), {
      parse_mode: "Markdown",
      ...buySettingsKeyboardBig(userId),
    });
    return;
  }

  if (flow === "AWAIT_SET_BUY_GASDELTA") {
    const v = Number(txt);
    if (!Number.isFinite(v) || v <= 0 || v > 1) {
      await ctx.reply("Invalid. Example: 0.005");
      return;
    }
    u.buy.gasDeltaSol = Number(v.toFixed(6));
    setUser(u);
    setFlow(userId, "NONE");
    await ctx.reply(await buildBuySettingsText(userId), {
      parse_mode: "Markdown",
      ...buySettingsKeyboardBig(userId),
    });
    return;
  }

  if (flow === "AWAIT_SET_BUY_PRICEIMPACT") {
    const v = Number(txt);
    if (!Number.isFinite(v) || v < 1 || v > 100) {
      await ctx.reply("Invalid. Example: 25");
      return;
    }
    u.buy.priceImpactPct = Math.round(v);
    setUser(u);
    setFlow(userId, "NONE");
    await ctx.reply(await buildBuySettingsText(userId), {
      parse_mode: "Markdown",
      ...buySettingsKeyboardBig(userId),
    });
    return;
  }

  if (flow === "AWAIT_SET_SELL_SLIPPAGE") {
    const v = Number(txt);
    if (!Number.isFinite(v) || v < 0.1 || v > 50) {
      await ctx.reply("Invalid. Example: 15");
      return;
    }
    u.sell.slippagePct = Number(v.toFixed(2));
    setUser(u);
    setFlow(userId, "NONE");
    await ctx.reply(await buildSellSettingsText(userId), {
      parse_mode: "Markdown",
      ...sellSettingsKeyboardBig(userId),
    });
    return;
  }

  if (flow === "AWAIT_SET_SELL_GASDELTA") {
    const v = Number(txt);
    if (!Number.isFinite(v) || v <= 0 || v > 1) {
      await ctx.reply("Invalid. Example: 0.005");
      return;
    }
    u.sell.gasDeltaSol = Number(v.toFixed(6));
    setUser(u);
    setFlow(userId, "NONE");
    await ctx.reply(await buildSellSettingsText(userId), {
      parse_mode: "Markdown",
      ...sellSettingsKeyboardBig(userId),
    });
    return;
  }

  if (flow === "AWAIT_SET_SELL_PRICEIMPACT") {
    const v = Number(txt);
    if (!Number.isFinite(v) || v < 1 || v > 100) {
      await ctx.reply("Invalid. Example: 50");
      return;
    }
    u.sell.priceImpactPct = Math.round(v);
    setUser(u);
    setFlow(userId, "NONE");
    await ctx.reply(await buildSellSettingsText(userId), {
      parse_mode: "Markdown",
      ...sellSettingsKeyboardBig(userId),
    });
    return;
  }

  if (flow === "AWAIT_SET_SELL_DURATION") {
    const v = Number(txt);
    if (!Number.isFinite(v) || v < 1 || v > 24 * 365) {
      await ctx.reply("Invalid. Example: 168");
      return;
    }
    u.sell.durationHours = Math.round(v);
    setUser(u);
    setFlow(userId, "NONE");
    await ctx.reply(await buildSellSettingsText(userId), {
      parse_mode: "Markdown",
      ...sellSettingsKeyboardBig(userId),
    });
    return;
  }

  if (flow === "AWAIT_SET_SL_PCT") {
    const v = Number(txt);
    if (!Number.isFinite(v) || v <= 0 || v > 1000) {
      await ctx.reply("Invalid. Example: 50");
      return;
    }
    setDraft(userId, { percentageChange: Number(v.toFixed(2)), activeField: "NONE" });
    setFlow(userId, "NONE");
    await ctx.reply(await buildSellLimitsText(userId), {
      parse_mode: "Markdown",
      ...sellLimitsKeyboard(userId),
    });
    return;
  }

  if (flow === "AWAIT_SET_SL_BAL") {
    const v = Number(txt);
    if (!Number.isFinite(v) || v < 1 || v > 100) {
      await ctx.reply("Invalid. Example: 25");
      return;
    }
    setDraft(userId, { balancePct: Math.round(v), activeField: "NONE" });
    setFlow(userId, "NONE");
    await ctx.reply(await buildSellLimitsText(userId), {
      parse_mode: "Markdown",
      ...sellLimitsKeyboard(userId),
    });
    return;
  }

  if (flow === "AWAIT_SET_SL_DUR") {
    const v = Number(txt);
    if (!Number.isFinite(v) || v < 1 || v > 24 * 365) {
      await ctx.reply("Invalid. Example: 168");
      return;
    }
    setDraft(userId, { durationHours: Math.round(v), activeField: "NONE" });
    setFlow(userId, "NONE");
    await ctx.reply(await buildSellLimitsText(userId), {
      parse_mode: "Markdown",
      ...sellLimitsKeyboard(userId),
    });
    return;
  }

  if (flow === "AWAIT_BUY_CA") {
    let mint: PublicKey;
    try {
      mint = new PublicKey(txt);
    } catch {
      await ctx.reply("❌ Invalid CA/mint. Paste again.");
      return;
    }

    activeBuyMint.set(userId, mint.toBase58());
    setFlow(userId, "NONE");

    await ctx.reply(await buildBuyTokenText(userId), {
      parse_mode: "Markdown",
      ...buyTokenKeyboard(userId),
    });
    return;
  }

  if (flow === "AWAIT_SELL_X_PCT") {
    const pct = parseInt(txt, 10);
    if (isNaN(pct) || pct < 1 || pct > 100) {
      await ctx.reply("❌ Enter a number between 1 and 100.");
      return;
    }
    setFlow(userId, "NONE");
    await executeSellFromActiveMint(ctx, userId, pct);
    return;
  }

  if (flow === "AWAIT_SELL_CA") {
    let mint: PublicKey;
    try {
      mint = new PublicKey(txt);
    } catch {
      await ctx.reply("❌ Invalid CA/mint. Paste again.");
      return;
    }

    setFlow(userId, "NONE");

    const def = getDefaultWallet(userId);
    if (!def) {
      await ctx.reply("Tap Wallet first to create your trading wallet.", { ...bonkMainMenu() });
      return;
    }

    try {
      const owner = new PublicKey(def.pubkey);
      const holding = await getTokenHolding(owner, mint);

      if (!holding || BigInt(holding.amountRaw) <= 0n) {
        await ctx.reply(
          `✅ CA received:\n\`${mint.toBase58()}\`\n\n❌ You have *0* of this token in your custodial wallet.`,
          { parse_mode: "Markdown", ...bonkMainMenu() }
        );
        return;
      }

      await ctx.reply(
        `✅ CA received:\n\`${mint.toBase58()}\`\n\nYour balance: *${holding.uiAmount}*\nChoose how much to sell:`,
        { parse_mode: "Markdown", ...sellPercentButtons(mint.toBase58()) }
      );
    } catch (e: any) {
      await ctx.reply(
        `✅ CA received:\n\`${mint.toBase58()}\`\n\nCould not read token balance.\n${e?.message ?? String(e)}`,
        { parse_mode: "Markdown", ...bonkMainMenu() }
      );
    }
    return;
  }if (flow === "AWAIT_IMPORT_WALLET_NAME") {
  importWalletNames.set(userId, txt);

  setFlow(userId, "AWAIT_IMPORT_WALLET_KEY");

  await ctx.reply(
    "🔑 Paste the private key for the wallet.\n\nSupported formats:\n• Base58\n• JSON array"
  );

  return;
}

if (flow === "AWAIT_IMPORT_WALLET_KEY") {
  let kp: Keypair;

  try {
    if (txt.startsWith("[")) {
      const arr = JSON.parse(txt);
      kp = Keypair.fromSecretKey(Uint8Array.from(arr));
    } else {
      const decoded = bs58.decode(txt);
      kp = Keypair.fromSecretKey(decoded);
    }
  } catch {
    await ctx.reply("❌ Invalid private key format.");
    return;
  }

  const name = importWalletNames.get(userId) || "wallet";

  const wallet = createWalletRecord(kp);
  wallet.name = name;

  const u = getUser(userId);

  // prevent duplicate imports
  if (u.wallets.some(w => w.pubkey === kp.publicKey.toBase58())) {
    await ctx.reply("⚠️ This wallet is already imported.");
    setFlow(userId, "NONE");
    return;
  }

  u.wallets.push(wallet);

  setUser(u);
  setFlow(userId, "NONE");

  await ctx.reply(
    `✅ Wallet imported successfully!\n\nName: ${name}\nAddress:\n${kp.publicKey.toBase58()}`
  );

  await showWalletMenu(ctx, userId);

  return;
}

  if (flow === "AWAIT_SEND_SOL_ADDRESS") {
  const address = txt;

  try {
    new PublicKey(address);
  } catch {
    await ctx.reply("❌ Invalid address. Paste a valid Solana address.");
    return;
  }

  sendSolAddress.set(userId, address);

  setFlow(userId, "AWAIT_SEND_SOL_AMOUNT");

  await ctx.reply("Enter amount of SOL to send.");
  return;

  
}

if (flow === "AWAIT_IMPORT_WALLET") {
  let kp: Keypair;

  try {
    const input = txt.trim();

    if (input.startsWith("[")) {
      const arr = JSON.parse(input);
      kp = Keypair.fromSecretKey(Uint8Array.from(arr));
    } else {
      const decoded = bs58.decode(input);
      kp = Keypair.fromSecretKey(decoded);
    }
  } catch {
    await ctx.reply("❌ Invalid private key format.");
    return;
  }

  const wallet = createWalletRecord(kp);

  const u = getUser(userId);
  u.wallets.push(wallet);

  setUser(u);
  setFlow(userId, "NONE");

  await ctx.reply(
    `✅ Wallet imported successfully!\n\nAddress:\n${kp.publicKey.toBase58()}`
  );

  return;
}

if (flow === "AWAIT_SEND_SOL_AMOUNT") {
  const amount = parseFloat(txt);

  if (isNaN(amount) || amount <= 0) {
    await ctx.reply("❌ Enter a valid SOL amount.");
    return;
  }

  const address = sendSolAddress.get(userId);

if (!address) {
  await ctx.reply("❌ No destination address found. Start again.");
  setFlow(userId, "NONE");
  return;
}

  const wallet = getDefaultWallet(userId);
  if (!wallet) {
    await ctx.reply("No wallet found.");
    return;
  }

  try {
    const kp = loadWalletKeypair(wallet);

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: kp.publicKey,
        toPubkey: new PublicKey(address),
        lamports: Math.floor(amount * LAMPORTS_PER_SOL),
      })
    );

    const sig = await sendAndConfirmTransaction(connection, tx, [kp]);

    await ctx.reply(`✅ Sent ${amount} SOL\n\nTx:\n${sig}`);

  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Transaction failed.");
  }

  setFlow(userId, "NONE");
  return;
}

  return next();
});

/* =========================
   LAUNCH
========================= */

console.log("✅ Starting bot...");

bot.catch((err: any) => {
  if (err?.response?.error_code === 429) return; // ignore rate limit noise
  if (err?.response?.error_code === 409) return; // ignore conflict noise
  console.error("🔥 Telegraf error:", err?.message ?? err);
});
process.on("unhandledRejection", (err) => console.error("🔥 Unhandled rejection:", err));

function encryptPrivateKey(secretKey: Uint8Array) {
  const key = Buffer.from(process.env.MASTER_KEY_BASE64!, "base64");

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const enc = Buffer.concat([
    cipher.update(Buffer.from(secretKey)),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    enc: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function createWalletRecord(kp: Keypair): WalletRecord {
  return {
    id: randomId(),
    pubkey: kp.publicKey.toBase58(),
    secretKey: JSON.stringify(Array.from(kp.secretKey)),
    createdAt: new Date().toISOString(),
    isDefault: false,
    isManual: false,
  };
}

/* =========================
   SELL LIMIT MONITOR
========================= */

async function runSellLimitMonitor() {
  const db = loadDB();
  const hasAnyOrders = Object.values(db.users).some((u: any) =>
    u.sellLimits?.length > 0 && u.positions?.length > 0
  );
  if (!hasAnyOrders) return;
  for (const raw of Object.values(db.users)) {
    const u = raw as any;
    if (!u.sellLimits?.length || !u.positions?.length) continue;
    if (!u.wallets?.length) continue;

    const def = u.wallets.find((w: any) => w.isDefault) ?? u.wallets[0];
    if (!def) continue;

    for (const pos of u.positions) {
      if (!pos.mint || !pos.wallet) continue;
      const info = await fetchTokenInfo(pos.mint).catch(() => null);
      if (!info || !info.price) continue;

      const entrySol: number = pos.entry || pos.entrySpentSol || 0;
      if (entrySol <= 0) continue;

      // Get current token balance
      let holding: any = null;
      try {
        holding = await getTokenHolding(new PublicKey(def.pubkey), new PublicKey(pos.mint));
      } catch { continue; }
      if (!holding || BigInt(holding.amountRaw) <= 0n) continue;

      const currentValue = holding.uiAmount * info.price;
      const pnlPct = ((currentValue - entrySol) / entrySol) * 100;

      for (const order of u.sellLimits) {
        let triggered = false;

        if (order.type === "TAKE_PROFIT" && pnlPct >= order.percentageChange) triggered = true;
        if (order.type === "STOP_LOSS"   && pnlPct <= order.percentageChange)  triggered = true;
        if (order.type === "TRAILING_SL") {
          // Simple trailing: trigger if dropped more than threshold from entry
          if (pnlPct <= -Math.abs(order.percentageChange)) triggered = true;
        }

        if (!triggered) continue;

        console.log(`🔔 Sell limit triggered for user ${u.userId}: ${order.type} at ${pnlPct.toFixed(2)}%`);

        try {
          const sellRaw = (BigInt(holding.amountRaw) * BigInt(order.balancePct)) / 100n;
          if (sellRaw <= 0n) continue;

          const userKp = loadWalletKeypair(def);
          const quote = await jupiterQuote({
            inputMint: pos.mint,
            outputMint: WSOL_MINT,
            amount: sellRaw.toString(),
            slippageBps: slippageBpsFromPct(u.sell?.slippagePct ?? 15),
          });
          const swap = await jupiterSwap({ userPublicKey: def.pubkey, quoteResponse: quote });
          const swapTxB64 = (swap as any)?.swapTransaction;
          if (!swapTxB64) continue;

          const sig = await signAndSendSwapTx(userKp, swapTxB64);

          await bot.telegram.sendMessage(
            u.userId,
            `🤖 *${order.type === "TAKE_PROFIT" ? "Take Profit" : order.type === "STOP_LOSS" ? "Stop Loss" : "Trailing SL"} triggered!*\n\n` +
            `Token: \`${pos.mint}\`\n` +
            `PnL at trigger: *${pnlPct.toFixed(2)}%*\n` +
            `Sold: *${order.balancePct}%* of balance\n\n` +
            `🧾 Tx: \`${sig}\``,
            { parse_mode: "Markdown" }
          ).catch(() => {});

          console.log(`✅ Sell limit executed for user ${u.userId}: ${sig}`);
        } catch (e) {
          console.error(`Sell limit execution failed for user ${u.userId}:`, e);
        }
      }
    }
  }
}

// Sell limit monitor disabled until paid RPC is available
// setInterval(() => {
//   runSellLimitMonitor().catch(e => console.error("Sell limit monitor error:", e));
// }, 300_000);

/* =========================
   ADMIN COMMANDS
========================= */

bot.command("admin", async (ctx) => {
  const userId = ctx.from!.id;
  if (userId !== ADMIN_USER_ID) return;
  const args = ctx.message.text.split(" ").slice(1);
  const cmd = args[0];

  if (cmd === "balance") {
    const bal = await getFeeAccumulatorBalance();
    await ctx.reply(`💰 *Fee Accumulator Balance*\n\nAddress: \`${FEE_ACCUMULATOR_PUBKEY}\`\nBalance: *${bal.toFixed(6)} SOL*`, { parse_mode: "Markdown" });
    return;
  }

  if (cmd === "withdraw") {
    const toAddress = args[1];
    const amount = parseFloat(args[2]);
    if (!toAddress || isNaN(amount) || amount <= 0) { await ctx.reply("Usage: /admin withdraw <address> <amount_sol>"); return; }
    try { new PublicKey(toAddress); } catch { await ctx.reply("❌ Invalid destination address."); return; }
    const bal = await getFeeAccumulatorBalance();
    if (amount > bal - 0.001) { await ctx.reply(`❌ Insufficient balance. Available: ${bal.toFixed(6)} SOL`); return; }
    await ctx.reply(`⏳ Withdrawing ${amount} SOL...`);
    try {
      const sig = await withdrawFees(toAddress, amount);
      await ctx.reply(`✅ *Withdrawal successful*\n\nAmount: *${amount} SOL*\nTo: \`${toAddress}\`\nTx: \`${sig}\``, { parse_mode: "Markdown" });
    } catch (e: any) { await ctx.reply(`❌ Withdrawal failed: ${e?.message ?? String(e)}`); }
    return;
  }

  if (cmd === "stats") {
    const db = loadDB();
    const userCount = Object.keys(db.users).length;
    const totalCopytradeWallets = Object.values(db.users).reduce((acc: number, u: any) => acc + (u.copytradeWallets?.length ?? 0), 0);
    const bal = await getFeeAccumulatorBalance();
    await ctx.reply(`📊 *Bot Stats*\n\n👥 Total users: *${userCount}*\n🤖 Copytrade wallets: *${totalCopytradeWallets}*\n💰 Fee balance: *${bal.toFixed(6)} SOL*`, { parse_mode: "Markdown" });
    return;
  }

  if (cmd === "broadcast") {
    const message = args.slice(1).join(" ");
    if (!message) { await ctx.reply("Usage: /admin broadcast <message>"); return; }
    const db2 = loadDB();
    const userIds2 = Object.keys(db2.users).map(Number);
    await ctx.reply(`📡 Broadcasting to ${userIds2.length} users...`);
    let success = 0; let failed = 0;
    for (const uid of userIds2) {
      try { await bot.telegram.sendMessage(uid, `📢 *Message from Atlas*

${message}`, { parse_mode: "Markdown" }); success++; }
      catch { failed++; }
      await new Promise(r => setTimeout(r, 50));
    }
    await ctx.reply(`✅ Broadcast complete

Sent: *${success}*
Failed: *${failed}*`, { parse_mode: "Markdown" });
    return;
  }

  if (cmd === "blacklist") {
    const subcmd = args[1]; const mintArg = args[2];
    if (subcmd === "add" && mintArg) { addToBlacklist(mintArg); await ctx.reply(`✅ Blacklisted: \`${mintArg}\``, { parse_mode: "Markdown" }); }
    else if (subcmd === "remove" && mintArg) { removeFromBlacklist(mintArg); await ctx.reply(`✅ Removed: \`${mintArg}\``, { parse_mode: "Markdown" }); }
    else if (subcmd === "list") {
      const list = [...getBlacklist()];
      const listText = list.length ? "🚫 *Blacklist:*\n\n" + list.map(m => "`" + m + "`").join("\n") : "🚫 Blacklist is empty.";
      await ctx.reply(listText, { parse_mode: "Markdown" });
    } else {
      await ctx.reply("/admin blacklist add <mint>\n/admin blacklist remove <mint>\n/admin blacklist list");
    }
    return;
  }

  await ctx.reply("🔧 *Admin Commands*\n\n/admin balance — fee wallet balance\n/admin withdraw <addr> <amt> — withdraw\n/admin stats — bot stats\n/admin broadcast <msg> — message all users\n/admin blacklist add/remove/list — token blacklist", { parse_mode: "Markdown" });
});

bot.command("refstats", async (ctx) => {
  const userId = ctx.from!.id;
  const u = getUser(userId);
  const botUsername = await getBotUsername();
  const refLink = `https://t.me/${botUsername}?start=ref_${u.referralCode}`;

  const db = loadDB();
  let totalReferrals = 0;
  let activeReferrals = 0;
  for (const raw of Object.values(db.users)) {
    const ru = raw as any;
    if (ru.referredBy === u.referralCode) {
      totalReferrals++;
      const createdAt = new Date(ru.createdAt).getTime();
      if (Date.now() - createdAt < 30 * 24 * 60 * 60 * 1000) {
        activeReferrals++;
      }
    }
  }

  const shareText = encodeURIComponent(`🚀 I'm trading Solana tokens with Atlas — the fastest Telegram trading bot!\n\nJoin with my link and we both earn:`);
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${shareText}`;

  await ctx.reply(
    `📊 *Your Referral Stats*\n\n` +
    `🔗 *Your link:*\n\`${refLink}\`\n\n` +
    `┌ Total referrals: *${totalReferrals}*\n` +
    `├ Active (30d window): *${activeReferrals}*\n` +
    `└ Lifetime earned: *${u.referrals.lifetimeSolEarned.toFixed(4)} SOL*\n\n` +
    `Payouts are automatic — sent to your default wallet after every trade your referrals make.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.url("📤 Share My Link", shareUrl)]]),
    }
  );
});

// ── Startup ──────────────────────────────────────────────────────────────
(async () => {
  // Wait 8s for any previous instance to fully shut down
  await new Promise(resolve => setTimeout(resolve, 8000));

  rebuildWalletFollowers();
  syncHeliusWebhookFromDB().catch(e => console.error("Helius sync error:", e));
  startWebhookServer(handleHeliusEvent);

  // Clear any stale polling sessions before launch
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });

  bot.launch({
    allowedUpdates: ["message", "callback_query"],
  }).catch((e) => {
    console.error("❌ Failed to launch bot:", e);
    process.exit(1);
  });

  console.log("🤖 Bot running... send /start in Telegram now");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
})();