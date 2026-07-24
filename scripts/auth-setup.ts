import http from "node:http";
import { OAuth2Client } from "google-auth-library";
import { Firestore } from "@google-cloud/firestore";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";

const cfg = loadConfig();
const REDIRECT = "http://localhost:3000/callback";
const SCOPES = [
  "https://www.googleapis.com/auth/chat.messages.readonly",
  "https://www.googleapis.com/auth/tasks",
];

const client = new OAuth2Client(cfg.oauthClientId, cfg.oauthClientSecret, REDIRECT);
const url = client.generateAuthUrl({
  access_type: "offline", prompt: "consent", scope: SCOPES,
});
console.log("\nOpen this URL in your browser (logged in as your WORK account):\n");
console.log(url + "\n");

http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", REDIRECT);
  if (u.pathname !== "/callback") { res.end(); return; }
  const code = u.searchParams.get("code");
  if (!code) { res.end("missing code"); return; }
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) { res.end("no refresh token — remove prior grant and retry"); return; }
  const store = new Store(new Firestore({ projectId: cfg.projectId }) as any);
  await store.setAuthTokens({ refreshToken: tokens.refresh_token });
  res.end("TaskLens authorized. You can close this tab.");
  console.log("refresh token stored in firestore auth/user. done.");
  process.exit(0);
}).listen(3000, () => console.log("waiting for callback on :3000 ..."));
