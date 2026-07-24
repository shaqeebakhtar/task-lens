import express from "express";
import { OAuth2Client } from "google-auth-library";
import { Firestore } from "@google-cloud/firestore";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { ChatClient } from "./chat.js";
import { classify } from "./classifier.js";
import { runPoll } from "./poll.js";
import { runDigest } from "./digest.js";
import { handleInteraction } from "./interact.js";
import { createTask } from "./tasks.js";

export interface AppDeps {
  apiSecret: string;
  verifyChat(authHeader: string | undefined): Promise<boolean>;
  poll(): Promise<{ classified: number; pinged: number }>;
  digest(): Promise<void>;
  interact(event: any): Promise<object>;
}

export function buildApp(deps: AppDeps) {
  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => res.status(200).send("ok"));

  const guarded = (fn: () => Promise<unknown>) =>
    async (req: express.Request, res: express.Response) => {
      if (req.header("x-api-secret") !== deps.apiSecret)
        return res.status(401).send("unauthorized");
      try { res.status(200).json((await fn()) ?? { ok: true }); }
      catch (e) { console.error(e); res.status(500).json({ error: String(e) }); }
    };

  app.post("/poll", guarded(deps.poll));
  app.post("/digest", guarded(deps.digest));

  app.post("/interact", async (req, res) => {
    if (!(await deps.verifyChat(req.header("authorization"))))
      return res.status(401).send("unauthorized");
    try { res.status(200).json(await deps.interact(req.body)); }
    catch (e) { console.error(e); res.status(500).json({ error: String(e) }); }
  });

  return app;
}

// ---- main ----
const cfg = loadConfig();
const store = new Store(new Firestore({ projectId: cfg.projectId }) as any);
const verifier = new OAuth2Client();

const deps: AppDeps = {
  apiSecret: cfg.apiSecret,
  async verifyChat(header) {
    const token = header?.replace(/^Bearer /, "");
    if (!token) return false;
    try {
      await verifier.verifyIdToken({ idToken: token, audience: cfg.projectNumber });
      return true;
    } catch { return false; }
  },
  async poll() {
    const chat = await ChatClient.forUser(cfg, store);
    return runPoll({
      chat, store,
      classify: (input) => classify(input, cfg),
      sendDm: (body) => ChatClient.sendAppDm(cfg, body),
      now: () => new Date().toISOString(),
      logOnly: cfg.logOnly,
    });
  },
  async digest() {
    await runDigest({
      store,
      sendDm: (body) => ChatClient.sendAppDm(cfg, body),
      now: () => new Date().toISOString(),
    });
  },
  async interact(event) {
    return handleInteraction(event, {
      store,
      createTask: (d) => (cfg.logOnly ? Promise.resolve() : createTask(d, cfg, store)),
    });
  },
};

const port = Number(process.env.PORT ?? 8080);
buildApp(deps).listen(port, () => console.log(`tasklens listening on :${port}`));
