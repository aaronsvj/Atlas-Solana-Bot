"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Users, DollarSign, Megaphone, Shield, Bot } from "lucide-react";

const links = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/users", label: "Users", icon: Users },
  { href: "/fees", label: "Fees", icon: DollarSign },
  { href: "/broadcast", label: "Broadcast", icon: Megaphone },
  { href: "/blacklist", label: "Blacklist", icon: Shield },
  { href: "/copytrade", label: "Copytrade", icon: Bot },
];

export default function Sidebar() {
  const pathname = usePathname();
  if (pathname === "/login") return null;
  return (
    <aside className="w-56 bg-[#0d1420] border-r border-[#1a2535] flex flex-col p-4">
      <div className="mb-8 px-2">
        <h1 className="text-lg font-bold text-white">Atlas | Solana</h1>
        <p className="text-xs text-[#64748b]">Admin Dashboard</p>
      </div>
      <nav className="space-y-1 flex-1">
        {links.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition ${
              pathname === href ? "bg-[#1a8cff] text-white" : "text-[#94a3b8] hover:bg-[#1a2535] hover:text-white"
            }`}>
            <Icon size={16} />{label}
          </Link>
        ))}
      </nav>
      <div className="px-2 py-2 border-t border-[#1a2535]">
        <p className="text-xs text-[#64748b]">Atlas | Solana Bot</p>
      </div>
    </aside>
  );
}
