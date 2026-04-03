import { Users, TrendingUp, DollarSign, Bot } from "lucide-react";

async function getStats() {
  try {
    const base = process.env.NEXT_PUBLIC_URL ?? "http://localhost:3000";
    const res = await fetch(`${base}/api/stats`, { cache: "no-store" });
    return res.json();
  } catch { return {}; }
}

function StatCard({ title, value, icon: Icon, color }: any) {
  return (
    <div className="bg-[#0d1420] border border-[#1a2535] rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <span className="text-[#64748b] text-sm">{title}</span>
        <div className={`p-2 rounded-lg ${color}`}><Icon size={16} /></div>
      </div>
      <p className="text-3xl font-bold text-white">{value ?? 0}</p>
    </div>
  );
}

export default async function Overview() {
  const stats = await getStats();
  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Overview</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard title="Total Users" value={stats.totalUsers} icon={Users} color="bg-blue-500/20 text-blue-400" />
        <StatCard title="New Today" value={stats.newToday} icon={TrendingUp} color="bg-green-500/20 text-green-400" />
        <StatCard title="Copytrade Active" value={stats.totalCopytrade} icon={Bot} color="bg-purple-500/20 text-purple-400" />
        <StatCard title="Total Positions" value={stats.totalPositions} icon={DollarSign} color="bg-yellow-500/20 text-yellow-400" />
      </div>
      <div className="bg-[#0d1420] border border-[#1a2535] rounded-xl p-6">
        <h3 className="text-lg font-semibold mb-4">Recent Users</h3>
        <table className="w-full text-sm">
          <thead><tr className="text-[#64748b] border-b border-[#1a2535]">
            <th className="text-left pb-3">User ID</th>
            <th className="text-left pb-3">Joined</th>
            <th className="text-left pb-3">Wallets</th>
            <th className="text-left pb-3">Positions</th>
          </tr></thead>
          <tbody>{(stats.users ?? []).slice(0, 10).map((u: any) => (
            <tr key={u.userId} className="border-b border-[#1a2535]/50 hover:bg-[#1a2535]/30">
              <td className="py-3 text-[#1a8cff]">{u.userId}</td>
              <td className="py-3 text-[#94a3b8]">{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—"}</td>
              <td className="py-3">{u.wallets}</td>
              <td className="py-3">{u.positions}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
