import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import type { Config } from "./config.js";
import type { Store } from "./store.js";
import type { Detection } from "./types.js";

export function taskPayload(d: Detection): { title: string; notes: string; due?: string } {
  return {
    title: d.title ?? `Task from ${d.requester ?? "chat"}`,
    notes: `Requested by: ${d.requester ?? "Unknown"}\nSource: ${d.sourceLink}\nCaptured by TaskLens`,
    ...(d.dueDate ? { due: new Date(`${d.dueDate}T00:00:00.000Z`).toISOString() } : {}),
  };
}

export async function createTask(d: Detection, cfg: Config, store: Store): Promise<void> {
  const tokens = await store.getAuthTokens();
  if (!tokens) throw new Error("no stored oauth tokens — run npm run auth");
  const auth = new OAuth2Client(cfg.oauthClientId, cfg.oauthClientSecret);
  auth.setCredentials({ refresh_token: tokens.refreshToken });
  const api = google.tasks({ version: "v1", auth });
  await api.tasks.insert({ tasklist: "@default", requestBody: taskPayload(d) });
}
