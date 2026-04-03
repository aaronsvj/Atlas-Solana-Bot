"use client";
import { useState, useEffect } from "react";

export default function FeesPage() {
  const [balance, setBalance] = useState<number | null>(null);
  const [toAddr, setToAddr] = useState("");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    fetch("/api/stats").then(r => r.json()).then(d => {
      // Balance not exposed in stats API — show placeholder
      setBalance(null);
    });
  }, []);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Fee Wallet</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-[#0d1420] border border-[#1a2535] rounded-xl p-6">
          <p className="text-[#64748b] text-sm mb-2">Current Balance</p>
          <p className="text-3xl font-bold text-white">{balance !== null ? `${balance.toFixed(4)} SOL` : "—"}</p>
          <p className="text-xs text-[#64748b] mt-2">Use /admin balance in Telegram for live balance</p>
        </div>
        <div className="bg-[#0d1420] border border-[#1a2535] rounded-xl p-6">
          <p className="text-[#64748b] text-sm mb-4">Withdraw via Telegram</p>
          <p className="text-sm text-[#94a3b8]">Use the bot command:</p>
          <code className="block mt-2 bg-[#080c14] rounded p-3 text-[#1a8cff] text-sm">/admin withdraw &lt;address&gt; &lt;amount&gt;</code>
        </div>
      </div>
    </div>
  );
}
