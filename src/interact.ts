import type { Store } from "./store.js";
import type { Detection } from "./types.js";

export interface InteractDeps {
  store: Store;
  createTask(d: Detection): Promise<void>;
}

function updateCard(text: string): object {
  return {
    actionResponse: { type: "UPDATE_MESSAGE" },
    text,
  };
}

export async function handleInteraction(event: any, deps: InteractDeps): Promise<object> {
  const fn: string | undefined = event?.common?.invokedFunction;
  const id: string | undefined = event?.common?.parameters?.detectionId;
  if (!fn || !id) return updateCard("⚠️ malformed interaction");

  const d = await deps.store.getDetection(id);
  if (!d) return updateCard("⚠️ detection not found (already handled?)");

  if (fn === "confirm_task") {
    if (d.status === "confirmed") return updateCard(`✅ already created: ${d.title}`);
    await deps.createTask(d);
    await deps.store.updateDetection(id, { status: "confirmed", updatedAt: new Date().toISOString() });
    return updateCard(`✅ Task created: ${d.title ?? "(no title)"}`);
  }
  if (fn === "dismiss_task") {
    await deps.store.updateDetection(id, { status: "dismissed", updatedAt: new Date().toISOString() });
    return updateCard("❌ Dismissed — thanks, this helps tuning.");
  }
  return updateCard(`⚠️ unknown action ${fn}`);
}
