import type { Store } from "./store.js";
import { digestMessage } from "./cards.js";

export interface DigestDeps {
  store: Store;
  sendDm(body: object): Promise<void>;
  now(): string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runDigest(deps: DigestDeps): Promise<void> {
  const since = new Date(new Date(deps.now()).getTime() - DAY_MS).toISOString();
  const [created, pending, unresolved] = await Promise.all([
    deps.store.listConfirmedSince(since),
    deps.store.listByStatus("pending"),
    deps.store.listByStatus("incomplete"),
  ]);
  await deps.sendDm(digestMessage(created, pending, unresolved));
}
