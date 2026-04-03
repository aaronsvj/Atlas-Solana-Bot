"use client";
import { useState } from "react";

export default function BroadcastPage() {
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  async function send() {
    if (!message.trim()) return;
    setLoading(true); setStatus("");
    const res = await fetch("/api/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    setStatus(`✅ Sent: ${data.success} | Failed: ${data.failed}`);
    setLoading(false);
    setMessage("");
  }

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Broadcast</h2>
      <div className="bg-[#0d1420] border border-[#1a2535] rounded-xl p-6 max-w-2xl">
        <p className="text-[#64748b] text-sm mb-4">Send a message to all bot users.</p>
        <textarea
          value={message} onChange={e => setMessage(e.target.value)}
          placeholder="Type your message here... (supports Markdown)"
          rows={6}
          className="w-full bg-[#080c14] border border-[#1a2535] rounded-lg px-4 py-3 text-white placeholder-[#64748b] focus:outline-none focus:border-[#1a8cff] resize-none mb-4"
        />
        {status && <p className="text-green-400 text-sm mb-4">{status}</p>}
        <button onClick={send} disabled={loading || !message.trim()}
          className="bg-[#1a8cff] hover:bg-[#1577dd] disabled:opacity-50 text-white font-semibold px-6 py-2.5 rounded-lg transition">
          {loading ? "Sending..." : "Send Broadcast"}
        </button>
      </div>
    </div>
  );
}
