"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatBubble } from "@/components/chat-bubble";
import { SearchCard } from "@/components/search-card";
import { fetchHistory, streamChat } from "@/lib/api";
import type { Message } from "@/lib/types";

const CACHE_KEY = "linda_chat_cache";

function loadCache(): Message[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "[]") as Message[];
  } catch {
    return [];
  }
}
function saveCache(msgs: Message[]) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(msgs.slice(-60)));
  } catch {
    /* ignore */
  }
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Instant render from cache, then reconcile with the latest page from D1.
  useEffect(() => {
    const cached = loadCache();
    if (cached.length) setMessages(cached);
    void fetchHistory()
      .then(({ messages: fresh, nextBefore: nb }) => {
        setMessages(fresh);
        setNextBefore(nb);
        saveCache(fresh);
      })
      .catch(() => setError("Gagal memuat riwayat."));
  }, []);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (!loadingOlder) scrollToBottom();
  }, [messages.length, sending, scrollToBottom, loadingOlder]);

  // Load older messages when scrolled near the top (infinite scroll-up).
  async function onScroll() {
    const el = scrollRef.current;
    if (!el || loadingOlder || nextBefore == null || el.scrollTop > 80) return;
    setLoadingOlder(true);
    const prevH = el.scrollHeight;
    try {
      const { messages: older, nextBefore: nb } = await fetchHistory(nextBefore);
      if (older.length) {
        setMessages((prev) => [...older, ...prev]);
        setNextBefore(nb);
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight - prevH;
        });
      } else {
        setNextBefore(null);
      }
    } finally {
      setLoadingOlder(false);
    }
  }

  // Mutate the streaming (last) assistant message.
  function patchLast(fn: (m: Message) => Message) {
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].role === "assistant") {
          next[i] = fn(next[i]);
          break;
        }
      }
      return next;
    });
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setError(null);
    setSending(true);

    const now = Date.now();
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text, timestamp: now },
      { role: "assistant", content: "", timestamp: now + 1 },
    ]);

    try {
      await streamChat(text, {
        onSearch: (query) => patchLast((m) => ({ ...m, search: { query, count: 0, sources: [], status: "searching" } })),
        onSources: (count, sources) =>
          patchLast((m) => ({ ...m, search: { query: m.search?.query ?? "", count, sources, status: "done" } })),
        onDelta: (t) => patchLast((m) => ({ ...m, content: m.content + t })),
        onDone: (d) => patchLast((m) => ({ ...m, content: d.reply, keyUsed: d.keyUsed, modelUsed: d.model, timestamp: d.timestamp })),
        onError: (msg) => patchLast((m) => ({ ...m, content: msg })),
      });
    } catch {
      setError("Gagal mengirim pesan. Coba lagi.");
      patchLast((m) => ({ ...m, content: m.content || "Gagal terhubung." }));
    } finally {
      setSending(false);
      setMessages((prev) => {
        saveCache(prev);
        return prev;
      });
    }
  }

  return (
    <div className="page-shell">
      <section className="chat-shell reveal">
        <header className="chat-header">
          <div>
            <div className="eyebrow">Chat AI</div>
            <h1 className="title-display">Linda AI Console</h1>
            <p className="mt-2 text-sm text-muted">
              Percakapan ini berbagi memori dengan WhatsApp. Riwayat disimpan lokal lalu disinkron
              saat koneksi stabil.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <span className="chip accent">Realtime streaming</span>
            <button type="button" onClick={scrollToBottom} className="btn-secondary">
              Scroll ke terbaru
            </button>
          </div>
        </header>

        <div ref={scrollRef} onScroll={onScroll} className="chat-stream">
          {loadingOlder && <p className="text-center text-xs text-muted">Memuat pesan lama...</p>}
          {messages.length === 0 && (
            <p className="text-sm text-muted">Belum ada percakapan. Sapa Linda untuk memulai.</p>
          )}

          {messages.map((m, i) => (
            <div key={m.id ?? `t${m.timestamp}-${i}`} className="space-y-3">
              {m.role === "assistant" && m.search && (
                <div className="chat-row">
                  <div className="chat-avatar">L</div>
                  <div className="chat-card search">
                    <SearchCard info={m.search} />
                  </div>
                </div>
              )}
              {(m.content || m.role === "user") && <ChatBubble message={m} />}
              {m.role === "assistant" && !m.content && !m.search && sending && i === messages.length - 1 && (
                <div className="chat-row">
                  <div className="chat-avatar">L</div>
                  <div className="typing-pill">Linda sedang mengetik</div>
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {error && <p className="alert">{error}</p>}

        <div className="compose-wrap">
          <form onSubmit={send} className="compose-bar">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Tulis pesan ke Linda..."
              disabled={sending}
              className="input-field flex-1"
            />
            <button type="submit" disabled={sending || !input.trim()} className="btn-primary">
              Kirim
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
