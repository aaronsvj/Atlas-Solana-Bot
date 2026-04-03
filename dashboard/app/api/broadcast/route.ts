import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function POST(req: NextRequest) {
  const { message } = await req.json();
  const botToken = process.env.BOT_TOKEN;
  const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), "..", "db.json");
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const userIds = Object.keys(db.users).map(Number);
  let success = 0, failed = 0;
  for (const uid of userIds) {
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: uid, text: `📢 ${message}`, parse_mode: "Markdown" }),
      });
      success++;
    } catch { failed++; }
    await new Promise(r => setTimeout(r, 50));
  }
  return NextResponse.json({ success, failed });
}
