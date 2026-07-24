import { describe, it, expect } from "vitest";
import { buildContextWindow } from "./context.js";
import type { ContextMessage } from "./types.js";

function msg(id: string, minutesAgoFromTrigger: number, sender: "me" | "them" = "them"): ContextMessage {
  const base = new Date("2026-07-18T14:00:00+05:30").getTime();
  return {
    messageId: `spaces/A/messages/${id}`,
    sender, senderName: sender === "me" ? "Shaqeeb" : "Rahul",
    text: `msg ${id}`,
    createTime: new Date(base - minutesAgoFromTrigger * 60_000).toISOString(),
  };
}

describe("buildContextWindow", () => {
  it("takes last 5 messages when the 30-min window has fewer", () => {
    // 7 messages all within 5 minutes -> time window gives 7, count gives 5 -> larger wins: 7
    const msgs = [6, 5, 4, 3, 2, 1, 0].map((m, i) => msg(`m${i}`, m));
    const win = buildContextWindow(msgs, msgs[6]);
    expect(win).toHaveLength(7);
  });
  it("takes 5 by count when older messages fall outside 30 minutes", () => {
    // 3 recent + 4 old (2h ago): time window -> 3, count -> 5. larger wins: 5
    const msgs = [120, 119, 118, 117, 2, 1, 0].map((m, i) => msg(`m${i}`, m));
    const win = buildContextWindow(msgs, msgs[6]);
    expect(win).toHaveLength(5);
    expect(win[win.length - 1].messageId).toBe(msgs[6].messageId);
  });
  it("never includes messages after the trigger", () => {
    const msgs = [3, 2, 1, 0].map((m, i) => msg(`m${i}`, m));
    const win = buildContextWindow(msgs, msgs[2]); // trigger is not last in array
    expect(win[win.length - 1].messageId).toBe(msgs[2].messageId);
    expect(win.find((m) => m.messageId === msgs[3].messageId)).toBeUndefined();
  });
  it("includes my own messages in the window", () => {
    const msgs = [2, 1, 0].map((m, i) => msg(`m${i}`, m, i === 1 ? "me" : "them"));
    const win = buildContextWindow(msgs, msgs[2]);
    expect(win.some((m) => m.sender === "me")).toBe(true);
  });
});
