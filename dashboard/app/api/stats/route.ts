import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET() {
  try {
    const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), "..", "db.json");
    const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    const users = Object.values(db.users) as any[];
    const now = Date.now();
    const oneDayAgo = now - 86400000;
    const sevenDaysAgo = now - 7 * 86400000;

    return NextResponse.json({
      totalUsers: users.length,
      newToday: users.filter(u => new Date((u as any).createdAt).getTime() > oneDayAgo).length,
      newThisWeek: users.filter(u => new Date((u as any).createdAt).getTime() > sevenDaysAgo).length,
      totalCopytrade: users.reduce((a, u: any) => a + (u.copytradeWallets?.length ?? 0), 0),
      totalPositions: users.reduce((a, u: any) => a + (u.positions?.length ?? 0), 0),
      users: users.map((u: any) => ({
        userId: u.userId,
        createdAt: u.createdAt,
        wallets: u.wallets?.length ?? 0,
        positions: u.positions?.length ?? 0,
        copytradeWallets: u.copytradeWallets?.length ?? 0,
        referredBy: u.referredBy,
        lifetimeEarned: u.referrals?.lifetimeSolEarned ?? 0,
      })),
      blacklist: db.tokenBlacklist ?? [],
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
