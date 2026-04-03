"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) { router.push("/"); router.refresh(); }
    else setError("Wrong password");
  }

  return (
    <div className="min-h-screen bg-[#080c14] flex items-center justify-center">
      <div className="bg-[#0d1420] border border-[#1a2535] rounded-xl p-8 w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-white">Atlas | Solana</h1>
          <p className="text-[#64748b] text-sm mt-1">Admin Dashboard</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full bg-[#080c14] border border-[#1a2535] rounded-lg px-4 py-3 text-white placeholder-[#64748b] focus:outline-none focus:border-[#1a8cff]"
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button type="submit" className="w-full bg-[#1a8cff] hover:bg-[#1577dd] text-white font-semibold py-3 rounded-lg transition">
            Login
          </button>
        </form>
      </div>
    </div>
  );
}
