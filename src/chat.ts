import { google, chat_v1 } from "googleapis";
import { OAuth2Client, GoogleAuth } from "google-auth-library";
import type { Config } from "./config.js";
import type { Store } from "./store.js";
import type { ContextMessage } from "./types.js";

// Quote text is not in the API response, only a reference — resolved separately below.
export function toContextMessage(
  raw: chat_v1.Schema$Message,
  myUserName: string,
): ContextMessage {
  return {
    messageId: raw.name ?? "",
    sender: raw.sender?.name === myUserName ? "me" : "them",
    senderName: raw.sender?.displayName ?? "Unknown",
    text: raw.text ?? "",
    createTime: raw.createTime ?? "",
  };
}

// spaces/AAA/messages/BBB -> https://chat.google.com/room/AAA/BBB
export function sourceLinkFor(messageId: string): string {
  const [, spaceId, , msgId] = messageId.split("/");
  return `https://chat.google.com/room/${spaceId}/${msgId}`;
}

export class ChatClient {
  private constructor(
    private api: chat_v1.Chat,
    public myUserName: string,
  ) {}

  static async forUser(cfg: Config, store: Store): Promise<ChatClient> {
    const tokens = await store.getAuthTokens();
    if (!tokens) throw new Error("no stored oauth tokens — run npm run auth");
    const auth = new OAuth2Client(cfg.oauthClientId, cfg.oauthClientSecret);
    auth.setCredentials({ refresh_token: tokens.refreshToken });
    const api = google.chat({ version: "v1", auth });
    // No "me" endpoint; users/{email} is an alias. Sender ids may not match it (see runbook).
    return new ChatClient(api, `users/${cfg.userEmail}`);
  }

  async listDmSpaces(): Promise<string[]> {
    const spaces: string[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.api.spaces.list({
        filter: 'spaceType = "DIRECT_MESSAGE"', pageSize: 100, pageToken,
      });
      for (const s of res.data.spaces ?? []) if (s.name) spaces.push(s.name);
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return spaces;
  }

  async fetchMessagesSince(spaceId: string, sinceIso: string): Promise<ContextMessage[]> {
    const out: ContextMessage[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.api.spaces.messages.list({
        parent: spaceId,
        filter: `createTime > "${sinceIso}"`,
        orderBy: "createTime ASC",
        pageSize: 100,
        pageToken,
      });
      for (const raw of res.data.messages ?? []) {
        const cm = toContextMessage(raw, this.myUserName);
        const quoted = await this.resolveQuote(raw.quotedMessageMetadata?.name);
        if (quoted) cm.quoted = quoted;
        out.push(cm);
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  // Cache quotes so the same one isn't fetched twice in a run.
  private quoteCache = new Map<string, { senderName: string; text: string }>();

  private async resolveQuote(
    quotedName: string | null | undefined,
  ): Promise<{ senderName: string; text: string } | undefined> {
    if (!quotedName) return undefined;
    const cached = this.quoteCache.get(quotedName);
    if (cached) return cached;
    try {
      const res = await this.api.spaces.messages.get({ name: quotedName });
      const q = {
        senderName: res.data.sender?.displayName ?? "Unknown",
        text: res.data.text ?? "",
      };
      this.quoteCache.set(quotedName, q);
      return q;
    } catch {
      // Quoted message gone or unreadable — skip it.
      return undefined;
    }
  }

  // Send a message/card from the app to the user's DM, using the app's own creds.
  static async sendAppDm(cfg: Config, body: object): Promise<void> {
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/chat.bot"] });
    const api = google.chat({ version: "v1", auth });
    const dm = await api.spaces.findDirectMessage({ name: `users/${cfg.userEmail}` });
    if (!dm.data.name) throw new Error("app has no DM with user — message the app once in chat");
    await api.spaces.messages.create({ parent: dm.data.name, requestBody: body });
  }
}
