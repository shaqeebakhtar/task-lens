import type { Classification, ClassifierInput, ContextMessage } from "./types.js";
import type { Store } from "./store.js";
import { buildContextWindow } from "./context.js";
import { makeDetection, mergeIncomplete, isExpired } from "./lifecycle.js";
import { confirmationCard } from "./cards.js";

export interface PollDeps {
  chat: {
    listDmSpaces(): Promise<string[]>;
    fetchMessagesSince(spaceId: string, sinceIso: string): Promise<ContextMessage[]>;
  };
  classify(input: ClassifierInput): Promise<Classification>;
  store: Store;
  sendDm(body: object): Promise<void>;
  now(): string;
  logOnly: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runPoll(deps: PollDeps): Promise<{ classified: number; pinged: number }> {
  const { store } = deps;
  let classified = 0, pinged = 0;
  const send = async (body: object) => {
    if (!deps.logOnly) { await deps.sendDm(body); pinged++; }
    else console.log("[log-only] would send:", JSON.stringify(body));
  };

  for (const spaceId of await deps.chat.listDmSpaces()) {
    const since = (await store.getLastSeen(spaceId))
      ?? new Date(new Date(deps.now()).getTime() - DAY_MS).toISOString();
    const msgs = await deps.chat.fetchMessagesSince(spaceId, since);

    // Resolve open incompletes with any new context first.
    const open = await store.listOpenIncomplete(spaceId);
    for (const d of open) {
      if (msgs.length > 0) {
        const merged = mergeIncomplete(d, msgs, await deps.classify({
          spaceId, trigger: msgs[msgs.length - 1],
          context: [...d.contextSnapshot, ...msgs], nowIst: deps.now(),
        }), deps.now());
        classified++;
        await store.saveDetection(merged);
        // Mark them processed so the loop below doesn't create a duplicate detection.
        for (const m of msgs) await store.markProcessed(m.messageId);
        if (merged.status === "pending") await send(confirmationCard(merged));
      }
    }

    for (const msg of msgs) {
      if (msg.sender !== "them") { await store.markProcessed(msg.messageId); continue; }
      if (await store.isProcessed(msg.messageId)) continue;
      const input: ClassifierInput = {
        spaceId, trigger: msg,
        context: buildContextWindow(msgs, msg), nowIst: deps.now(),
      };
      const c = await deps.classify(input);
      classified++;
      if (c.verdict !== "not_task") {
        const existing = await store.getDetection(
          makeDetection(input, c, deps.now()).id,
        );
        if (!existing) {
          const d = makeDetection(input, c, deps.now());
          await store.saveDetection(d);
          if (d.status === "pending") await send(confirmationCard(d));
        }
      }
      await store.markProcessed(msg.messageId);
    }

    if (msgs.length > 0) {
      const newest = msgs.reduce((a, b) =>
        new Date(a.createTime) > new Date(b.createTime) ? a : b);
      await store.setLastSeen(spaceId, newest.createTime);
    }
  }

  // Stale incompletes: ping anyway as "details unclear".
  for (const d of await store.listByStatus("incomplete")) {
    if (isExpired(d, deps.now())) {
      const flipped = { ...d, status: "pending" as const, updatedAt: deps.now() };
      await store.saveDetection(flipped);
      await send(confirmationCard(flipped, true));
    }
  }

  return { classified, pinged };
}
