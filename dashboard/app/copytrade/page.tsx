"use client";
import { useEffect, useState } from "react";

export default function CopytradePage() {
  const [users, setUsers] = useState<any[]>([]);

  useEffect(() => { fetch("/api/stats").then(r => r.json()).then(d => setUsers(d.users ?? [])); }, []);

  const active = users.filter(u => u.copytradeWallets > 0);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Copytrade Subscriptions</h2>
      <p className="text-[#64748b] mb-4">{active.length} users with active copytrade</p>
      <div className="bg-[#0d1420] border border-[#1a2535] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="text-[#64748b] border-b border-[#1a2535]">
            <th className="text-left px-6 py-3">User ID</th>
            <th className="text-left px-6 py-3">Wallets Followed</th>
            <th className="text-left px-6 py-3">Positions</th>
          </tr></thead>
          <tbody>
            {active.map((u: any) => (
              <tr key={u.userId} className="border-b border-[#1a2535]/50 hover:bg-[#1a2535]/30">
                <td className="px-6 py-3 text-[#1a8cff]">{u.userId}</td>
                <td className="px-6 py-3">{u.copytradeWallets}</td>
                <td className="px-6 py-3">{u.positions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
