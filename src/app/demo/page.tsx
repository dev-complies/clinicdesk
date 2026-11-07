"use client";

import { useEffect, useRef, useState } from "react";
import {
  MID_STREAM_CUTOFF_MESSAGE,
  SendMessageResult,
  sendMessageStream,
} from "../../lib/chat-client";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  isError?: boolean;
}

export default function DemoChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "connecting" | "streaming">("idle");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [lastFailedMessage, setLastFailedMessage] = useState<string | null>(null);

  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const isUserScrolledUpRef = useRef(false);

  // Monitor user scrolling: if user scrolls away from bottom, don't force auto-scroll
  const handleScroll = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Considered scrolled up if more than 60px from the bottom
    isUserScrolledUpRef.current = distanceToBottom > 60;
  };

  const scrollToBottom = (force = false) => {
    if (force || !isUserScrolledUpRef.current) {
      bottomAnchorRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, status]);

  // Abort in-flight request when component unmounts
  useEffect(() => {
    return () => {
      activeAbortControllerRef.current?.abort();
    };
  }, []);

  const handleResetChat = () => {
    activeAbortControllerRef.current?.abort();
    setMessages([]);
    setConversationId(null);
    setLastFailedMessage(null);
    setInput("");
    setStatus("idle");
  };

  const handleSendMessage = async (textToSend: string, isRetry = false) => {
    if (status !== "idle") return;
    const trimmed = textToSend.trim();
    if (!trimmed) return;

    // Abort previous in-flight request if any
    activeAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    activeAbortControllerRef.current = abortController;

    // Reset error / retry state
    setLastFailedMessage(null);

    // If not a retry, add the user bubble. If retrying, keep existing bubble
    if (!isRetry) {
      const userMsgId = `user-${Date.now()}`;
      setMessages((prev) => [...prev, { id: userMsgId, role: "user", text: trimmed }]);
      setInput("");
    }

    setStatus("connecting");
    const assistantMsgId = `assistant-${Date.now()}`;
    let hasCreatedAssistantBubble = false;

    try {
      const result: SendMessageResult = await sendMessageStream(
        {
          message: trimmed,
          conversationId,
          signal: abortController.signal,
          onConversationId: (newId) => {
            setConversationId(newId);
          },
          onChunk: (delta) => {
            setStatus("streaming");
            if (!hasCreatedAssistantBubble) {
              hasCreatedAssistantBubble = true;
              setMessages((prev) => [
                ...prev,
                { id: assistantMsgId, role: "assistant", text: delta },
              ]);
            } else {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId ? { ...m, text: m.text + delta } : m
                )
              );
            }
          },
        },
        fetch
      );

      if (result.ok) {
        if (!hasCreatedAssistantBubble) {
          setMessages((prev) => [
            ...prev,
            { id: assistantMsgId, role: "assistant", text: result.fullText },
          ]);
        }
        setStatus("idle");
      } else {
        setStatus("idle");
        if (result.errorKind === "expired_conversation") {
          // Keep visible history, clear only conversation id, let user retry
          setConversationId(null);
          setMessages((prev) => [
            ...prev,
            {
              id: `err-${Date.now()}`,
              role: "assistant",
              text: result.errorMessage,
              isError: true,
            },
          ]);
          setLastFailedMessage(trimmed);
        } else if (result.errorKind === "busy") {
          setMessages((prev) => [
            ...prev,
            {
              id: `err-${Date.now()}`,
              role: "assistant",
              text: result.errorMessage,
              isError: true,
            },
          ]);
          setLastFailedMessage(trimmed);
        } else if (result.errorKind === "mid_stream_cutoff") {
          // Kept partial text in bubble; append cautionary note
          setMessages((prev) => [
            ...prev,
            {
              id: `err-${Date.now()}`,
              role: "assistant",
              text: result.errorMessage,
              isError: true,
            },
          ]);
          // No auto retry on mid-stream cutoff per requirement
        } else {
          // rate_limited or generic
          setMessages((prev) => [
            ...prev,
            {
              id: `err-${Date.now()}`,
              role: "assistant",
              text: result.errorMessage,
              isError: true,
            },
          ]);
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        // Ignored: intentional abort or unmount
        return;
      }
      setStatus("idle");
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          text: "Something went wrong. Please try again.",
          isError: true,
        },
      ]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ignore Enter if composing (IME for Hindi / Hinglish)
    if (e.nativeEvent.isComposing) {
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (status === "idle" && input.trim()) {
        handleSendMessage(input);
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (status === "idle" && input.trim()) {
      handleSendMessage(input);
    }
  };

  return (
    <div className="flex flex-col h-screen max-h-screen bg-zinc-50 dark:bg-zinc-950 font-sans text-zinc-900 dark:text-zinc-100 antialiased">
      {/* ── HEADER ── */}
      <header className="flex items-center justify-between px-4 py-3 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <div className="flex items-center space-x-2">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
          <h1 className="font-semibold text-base sm:text-lg text-zinc-900 dark:text-zinc-50">
            Demo Clinic A
          </h1>
        </div>
        <button
          type="button"
          onClick={handleResetChat}
          className="px-3 py-1.5 text-xs sm:text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400"
        >
          New chat
        </button>
      </header>

      {/* ── FIXED NOTICE BANNER ── */}
      <div
        role="note"
        aria-label="Medical disclaimer"
        className="px-4 py-2 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900/50 text-amber-800 dark:text-amber-300 text-xs text-center shrink-0"
      >
        AI assistant. It cannot give medical advice. In an emergency call{" "}
        <strong className="font-semibold">112</strong>.
      </div>

      {/* ── MESSAGES CONTAINER ── */}
      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-busy={status !== "idle"}
        className="flex-1 overflow-y-auto px-4 py-6 space-y-4 max-w-3xl w-full mx-auto"
      >
        {messages.length === 0 && status === "idle" && (
          <div className="text-center text-zinc-500 dark:text-zinc-400 py-12 text-sm">
            How can I help you with Demo Clinic A today?
          </div>
        )}

        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex flex-col ${
              m.role === "user" ? "items-end" : "items-start"
            }`}
          >
            <div
              className={`max-w-[85%] sm:max-w-[75%] rounded-2xl px-4 py-2.5 text-sm sm:text-base leading-relaxed whitespace-pre-wrap break-words ${
                m.role === "user"
                  ? "bg-blue-600 text-white rounded-br-none"
                  : m.isError
                  ? "bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 border border-rose-200 dark:border-rose-900/50 rounded-bl-none"
                  : "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm border border-zinc-200 dark:border-zinc-700/60 rounded-bl-none"
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}

        {/* Typing indicator */}
        {status === "connecting" && (
          <div className="flex items-start">
            <div className="bg-white dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 rounded-2xl rounded-bl-none px-4 py-3 shadow-sm border border-zinc-200 dark:border-zinc-700/60 flex items-center space-x-1.5 text-xs">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-bounce" />
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-bounce [animation-delay:0.2s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-bounce [animation-delay:0.4s]" />
            </div>
          </div>
        )}

        {/* Retry button for 503 or expired conversation */}
        {lastFailedMessage && status === "idle" && (
          <div className="flex flex-col items-start space-y-1.5 pt-1">
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {MID_STREAM_CUTOFF_MESSAGE}
            </p>
            <button
              type="button"
              onClick={() => handleSendMessage(lastFailedMessage, true)}
              className="inline-flex items-center px-3 py-1.5 text-xs font-semibold text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/60 hover:bg-blue-100 dark:hover:bg-blue-900/60 border border-blue-200 dark:border-blue-800 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              Try again
            </button>
          </div>
        )}

        <div ref={bottomAnchorRef} />
      </div>

      {/* ── FOOTER / INPUT SECTION ── */}
      <div className="shrink-0 max-w-3xl w-full mx-auto px-4 pb-4 pt-2">
        {/* Quick-reply chips (shown when conversation is empty) */}
        {messages.length === 0 && status === "idle" && (
          <div
            role="group"
            aria-label="Suggested questions"
            className="flex flex-wrap gap-2 mb-3"
          >
            {[
              "Which doctors do you have?",
              "Book an appointment",
              "Clinic timings",
            ].map((chip) => (
              <button
                key={chip}
                type="button"
                disabled={status !== "idle"}
                onClick={() => handleSendMessage(chip)}
                className="px-3 py-1.5 text-xs sm:text-sm font-medium text-zinc-700 dark:text-zinc-300 bg-white dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 border border-zinc-200 dark:border-zinc-700 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400 shadow-xs"
              >
                {chip}
              </button>
            ))}
          </div>
        )}

        {/* Input box */}
        <form
          onSubmit={handleSubmit}
          className="bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-2xl shadow-sm focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent transition-all"
        >
          <label htmlFor="chat-message-input" className="sr-only">
            Chat message
          </label>
          <textarea
            id="chat-message-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            maxLength={1000}
            rows={2}
            disabled={status !== "idle"}
            placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
            className="w-full resize-none px-4 pt-3 pb-1 text-sm sm:text-base bg-transparent border-0 outline-none text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 disabled:opacity-50"
          />
          <div className="flex items-center justify-between px-3 pb-2 pt-1 border-t border-zinc-100 dark:border-zinc-800">
            <span
              className={`text-[11px] ${
                input.length > 950
                  ? "text-rose-500 font-semibold"
                  : "text-zinc-400 dark:text-zinc-500"
              }`}
            >
              {input.length}/1000
            </span>
            <button
              type="submit"
              disabled={status !== "idle" || !input.trim()}
              className="inline-flex items-center justify-center px-4 py-1.5 text-xs sm:text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:bg-zinc-200 dark:disabled:bg-zinc-800 disabled:text-zinc-400 dark:disabled:text-zinc-600 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

