import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const getDbPath = () => process.env.DB_PATH ?? path.join(process.cwd(), "..", "db.json");

export async function GET() {
  const db = JSON.parse(fs.readFileSync(getDbPath(), "utf8"));
  return NextResponse.json({ blacklist: db.tokenBlacklist ?? [] });
}

export async function POST(req: NextRequest) {
  const { mint, action } = await req.json();
  const dbPath = getDbPath();
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  if (!db.tokenBlacklist) db.tokenBlacklist = [];
  if (action === "add" && !db.tokenBlacklist.includes(mint)) db.tokenBlacklist.push(mint);
  if (action === "remove") db.tokenBlacklist = db.tokenBlacklist.filter((m: string) => m !== mint);
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  return NextResponse.json({ ok: true });
}
