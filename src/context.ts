import type { ContextMessage } from "./types.js";

const WINDOW_MS = 30 * 60 * 1000;
const WINDOW_COUNT = 5;

/** Chronological context ending at trigger: last 5 msgs or 30 min, whichever is MORE. */
export function buildContextWindow(
  messages: ContextMessage[],
  trigger: ContextMessage,
): ContextMessage[] {
  const sorted = [...messages].sort(
    (a, b) => new Date(a.createTime).getTime() - new Date(b.createTime).getTime(),
  );
  const idx = sorted.findIndex((m) => m.messageId === trigger.messageId);
  const upTo = idx === -1 ? sorted : sorted.slice(0, idx + 1);
  const cutoff = new Date(trigger.createTime).getTime() - WINDOW_MS;
  const byTime = upTo.filter((m) => new Date(m.createTime).getTime() >= cutoff);
  const byCount = upTo.slice(-WINDOW_COUNT);
  return byTime.length >= byCount.length ? byTime : byCount;
}
