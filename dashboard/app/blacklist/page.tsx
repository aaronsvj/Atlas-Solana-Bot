"use client";
import { useState, useEffect } from "react";

export default function BlacklistPage() {
  const [list, setList] = useState<string[]>([]);
  const [mint, setMint] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => { fetch("/api/blacklist").then(r => r.json()).then(d => setList(d.blacklist ?? [])); }, []);

  async function add() {
    if (!mint.trim()) return;
    setLoading(true);
    await fetch("/api/blacklist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mint: mint.trim(), action: "add" }) });
    setList(l => [...l, mint.trim()]); setMint(""); setLoading(false);
  }

  async function remove(m: string) {
    await fetch("/api/blacklist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mint: m, action: "remove" }) });
    setList(l => l.filter(x => x !== m));
  }

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Token Blacklist</h2>
      <div className="bg-[#0d1420] border border-[#1a2535] rounded-xl p-6 max-w-2xl mb-6">
        <div className="flex gap-3">
          <input value={mint} onChange={e => setMint(e.target.value)} placeholder="Token mint address"
            className="flex-1 bg-[#080c14] border border-[#1a2535] rounded-lg px-4 py-2 text-white placeholder-[#64748b] focus:outline-none focus:border-[#1a8cff]" />
          <button onClick={add} disabled={loading} className="bg-[#1a8cff] hover:bg-[#1577dd] text-white px-4 py-2 rounded-lg transition">Add</button>
        </div>
      </div>
      <div className="bg-[#0d1420] border border-[#1a2535] rounded-xl overflow-hidden">
        {list.length === 0 ? (
          <p className="p-6 text-[#64748b]">No blacklisted tokens.</p>
        ) : list.map(m => (
          <div key={m} className="flex items-center justify-between px-6 py-3 border-b border-[#1a2535]/50">
            <span className="font-mono text-sm text-[#94a3b8]">{m}</span>
            <button onClick={() => remove(m)} className="text-red-400 hover:text-red-300 text-sm transition">Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
}
