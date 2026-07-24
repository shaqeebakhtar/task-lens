import type { ClassifierInput, Classification, ContextMessage, Detection } from "./types.js";
import { sourceLinkFor } from "./chat.js";
import { Store } from "./store.js";

const EXPIRY_MS = 2 * 60 * 60 * 1000;

export function makeDetection(
  input: ClassifierInput, c: Classification, nowIso: string,
): Detection {
  return {
    id: Store.docId(input.trigger.messageId),
    spaceId: input.spaceId,
    messageIds: [input.trigger.messageId],
    contextSnapshot: input.context,
    verdict: c.verdict,
    title: c.title,
    dueDate: c.dueDate,
    requester: c.requester ?? input.trigger.senderName,
    status: c.verdict === "task" ? "pending" : "incomplete",
    sourceLink: sourceLinkFor(input.trigger.messageId),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export function mergeIncomplete(
  existing: Detection, newContext: ContextMessage[], c: Classification, nowIso: string,
): Detection {
  return {
    ...existing,
    messageIds: [...existing.messageIds, ...newContext.map((m) => m.messageId)],
    contextSnapshot: [...existing.contextSnapshot, ...newContext],
    verdict: c.verdict,
    title: c.title ?? existing.title,
    dueDate: c.dueDate ?? existing.dueDate,
    requester: c.requester ?? existing.requester,
    status: c.verdict === "task" ? "pending" : "incomplete",
    updatedAt: nowIso,
  };
}

export function isExpired(d: Detection, nowIso: string): boolean {
  if (d.status !== "incomplete") return false;
  return new Date(nowIso).getTime() - new Date(d.createdAt).getTime() > EXPIRY_MS;
}
