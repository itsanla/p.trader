import { formatTime } from "@/lib/format";
import type { Message } from "@/lib/types";

export function ChatBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <div className={`chat-row ${isUser ? "user" : ""}`}>
      <div className={`chat-avatar ${isUser ? "user" : ""}`}>{isUser ? "K" : "L"}</div>
      <div className={`chat-card ${isUser ? "user" : ""}`}>
        <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
        <div className="chat-meta">
          <span>{formatTime(message.timestamp)}</span>
          {message.keyUsed && message.keyUsed !== "none" && (
            <span className="font-mono">· {message.keyUsed}</span>
          )}
        </div>
      </div>
    </div>
  );
}
