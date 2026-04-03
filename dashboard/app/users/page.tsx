"use client";
import { useState, useEffect } from "react";

export default function UsersPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/stats").then(r => r.json()).then(d => setUsers(d.users ?? []));
  }, []);

  const filtered = users.filter(u =>
    String(u.userId).includes(search) || String(u.referredBy ?? "").includes(search)
  );

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Users</h2>
      <input
        value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Search by user ID..."
        className="mb-4 w-full max-w-sm bg-[#0d1420] border border-[#1a2535] rounded-lg px-4 py-2 text-white placeholder-[#64748b] focus:outline-none focus:border-[#1a8cff]"
      />
      <div className="bg-[#0d1420] border border-[#1a2535] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="text-[#64748b] border-b border-[#1a2535]">
            <th className="text-left px-6 py-3">User ID</th>
            <th className="text-left px-6 py-3">Joined</th>
            <th className="text-left px-6 py-3">Wallets</th>
            <th className="text-left px-6 py-3">Positions</th>
            <th className="text-left px-6 py-3">Copytrade</th>
            <th className="text-left px-6 py-3">Ref Earned</th>
          </tr></thead>
          <tbody>
            {filtered.map((u: any) => (
              <>
                <tr key={u.userId} onClick={() => setExpanded(expanded === u.userId ? null : u.userId)}
                  className="border-b border-[#1a2535]/50 hover:bg-[#1a2535]/30 cursor-pointer">
                  <td className="px-6 py-3 text-[#1a8cff]">{u.userId}</td>
                  <td className="px-6 py-3 text-[#94a3b8]">{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—"}</td>
                  <td className="px-6 py-3">{u.wallets}</td>
                  <td className="px-6 py-3">{u.positions}</td>
                  <td className="px-6 py-3">{u.copytradeWallets}</td>
                  <td className="px-6 py-3 text-green-400">{u.lifetimeEarned?.toFixed(4)} SOL</td>
                </tr>
                {expanded === u.userId && (
                  <tr key={`${u.userId}-detail`} className="bg-[#1a2535]/20">
                    <td colSpan={6} className="px-6 py-3 text-[#94a3b8] text-xs">
                      Referred by: {u.referredBy ?? "none"}
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
