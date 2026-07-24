# TaskLens Implementation Plan

**Goal:** A headless Node.js/TypeScript Cloud Run service that polls the user's Google Chat DMs during working hours, classifies task-like messages (English/Hinglish) with Gemini Flash using full conversational context, and creates Google Tasks after a one-tap chat-card confirmation.

**Architecture:** Single Express service with three endpoints — `/poll` (Cloud Scheduler, every 15 min during work hours), `/interact` (Google Chat button clicks), `/digest` (daily 9:00 summary). State lives in Firestore (poll cursors, detection lifecycle, dedupe). Reading chats uses the user's own OAuth credentials; sending confirmation cards uses the Chat app's service-account credentials.

**Tech Stack:** Node.js 20+, TypeScript (strict, ESM), Express, `googleapis` (Chat + Tasks APIs), `@google/genai` (Gemini), `@google-cloud/firestore`, `vitest` for tests, `tsx` for local dev, Docker + Cloud Run + Cloud Scheduler.

## Global Constraints

- Spec: `docs/design.md` — read it before starting.
- Node.js >= 20, TypeScript `strict: true`, ESM (`"type": "module"`; local imports use `.js` extensions).
- Timezone for all scheduling and date math: `Asia/Kolkata` (IST).
- Poll cron: `*/15 9-19 * * 1-5` IST. Digest cron: `0 9 * * 1-5` IST.
- Context window rule: last **5 messages or 30 minutes, whichever yields more messages**, plus any quoted message.
- Incomplete-task timeout: **2 hours**, after which it pings anyway as "possible task, details unclear".
- Classifier bias: **when unsure, lean toward `task`** (false ping is cheap; a miss recreates the original problem).
- Gemini model: `gemini-2.5-flash` (env-overridable via `GEMINI_MODEL`).
- OAuth scopes (user): `https://www.googleapis.com/auth/chat.messages.readonly`, `https://www.googleapis.com/auth/tasks`.
- The user's own messages are never task **triggers** but always appear in context.
- `LOG_ONLY=true` env flag: full pipeline runs but no cards are sent and no tasks are created (dry-run mode for the go-live day).
- Commit style (user preference, overrides all examples anywhere): single short lowercase subject, no body, no co-author trailer. Example: `add context window builder`.
- Tests: `vitest`, colocated as `src/<name>.test.ts`. Run with `npx vitest run`.

## File Structure

```
task-lens/
├── package.json, tsconfig.json, vitest.config.ts, .gitignore, .env.example
├── Dockerfile
├── src/
│   ├── types.ts        — shared types (ContextMessage, Classification, Detection…)
│   ├── config.ts       — env loading/validation
│   ├── context.ts      — pure: context window assembly
│   ├── classifier.ts   — prompt builder, response parser, Gemini call
│   ├── store.ts        — Firestore: spaces cursors, detections, processed dedupe
│   ├── chat.ts         — Chat API: list DMs, fetch messages, resolve quotes, send card DM
│   ├── cards.ts        — pure: confirmation card JSON + digest text
│   ├── lifecycle.ts    — pure: detection creation/merge/expiry decisions
│   ├── tasks.ts        — Google Tasks creation
│   ├── poll.ts         — /poll orchestration
│   ├── interact.ts     — /interact button handling
│   ├── digest.ts       — /digest summary
│   └── index.ts        — Express wiring + request auth
├── scripts/
│   ├── auth-setup.ts          — one-time OAuth flow, stores refresh token in Firestore
│   └── validate-classifier.ts — Phase-1 harness against real sample messages
└── samples/messages.jsonl     — real chat samples (gitignored — private work data)
```

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a repo where `npx vitest run` and `npx tsc --noEmit` both pass

- [ ] **Step 1: Create package.json**

```json
{
  "name": "task-lens",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "test": "vitest run",
    "auth": "tsx scripts/auth-setup.ts",
    "validate": "tsx scripts/validate-classifier.ts"
  },
  "dependencies": {
    "@google-cloud/firestore": "^7.11.0",
    "@google/genai": "^1.9.0",
    "express": "^4.21.0",
    "google-auth-library": "^9.15.0",
    "googleapis": "^148.0.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.17.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": ".",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*", "scripts/**/*"],
  "exclude": ["**/*.test.ts"]
}
```

- [ ] **Step 3: Create vitest.config.ts, .gitignore, .env.example**

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
```

`.gitignore`:
```
node_modules/
dist/
.env
samples/
*.local.json
```

`.env.example`:
```
GCP_PROJECT_ID=
GCP_PROJECT_NUMBER=
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
OAUTH_CLIENT_ID=
OAUTH_CLIENT_SECRET=
API_SECRET=
USER_EMAIL=shaqeeb.akhtar@wisdmlabs.com
LOG_ONLY=false
```

- [ ] **Step 4: Write smoke test `src/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";

describe("toolchain", () => {
  it("runs typescript tests", () => {
    const x: number = 1 + 1;
    expect(x).toBe(2);
  });
});
```

- [ ] **Step 5: Install and verify**

Run: `npm install && npx vitest run && npx tsc --noEmit`
Expected: 1 test passes, tsc emits no errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "scaffold typescript project"
```

---

### Task 2: Shared types and config loader

**Files:**
- Create: `src/types.ts`, `src/config.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces (used by every later task):
  - `types.ts`: `Verdict`, `ContextMessage`, `ClassifierInput`, `Classification`, `DetectionStatus`, `Detection`
  - `config.ts`: `loadConfig(env?): Config`

- [ ] **Step 1: Write `src/types.ts`**

```ts
export type Verdict = "not_task" | "task" | "task_incomplete";

export interface ContextMessage {
  messageId: string; // full resource name: spaces/AAA/messages/BBB
  sender: "me" | "them";
  senderName: string;
  text: string;
  createTime: string; // ISO 8601
  quoted?: { senderName: string; text: string };
}

export interface ClassifierInput {
  spaceId: string;
  trigger: ContextMessage;
  context: ContextMessage[]; // chronological, trigger is last element
  nowIst: string; // e.g. "2026-07-18T14:30:00+05:30"
}

export interface Classification {
  verdict: Verdict;
  title: string | null;
  dueDate: string | null; // YYYY-MM-DD
  requester: string | null;
  confidence: number; // 0..1
  reasoning: string;
}

export type DetectionStatus =
  | "incomplete"
  | "pending"
  | "confirmed"
  | "dismissed"
  | "expired";

export interface Detection {
  id: string; // trigger messageId with "/" replaced by "_"
  spaceId: string;
  messageIds: string[];
  contextSnapshot: ContextMessage[];
  verdict: Verdict;
  title: string | null;
  dueDate: string | null;
  requester: string | null;
  status: DetectionStatus;
  sourceLink: string; // https://chat.google.com deep link
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Write failing test `src/config.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const FULL = {
  GCP_PROJECT_ID: "p", GCP_PROJECT_NUMBER: "123", GEMINI_API_KEY: "k",
  OAUTH_CLIENT_ID: "id", OAUTH_CLIENT_SECRET: "s", API_SECRET: "sec",
  USER_EMAIL: "u@x.com",
};

describe("loadConfig", () => {
  it("loads all vars with defaults", () => {
    const c = loadConfig(FULL);
    expect(c.geminiModel).toBe("gemini-2.5-flash");
    expect(c.logOnly).toBe(false);
    expect(c.userEmail).toBe("u@x.com");
  });
  it("throws naming the missing var", () => {
    const { GEMINI_API_KEY, ...rest } = FULL;
    expect(() => loadConfig(rest)).toThrow(/GEMINI_API_KEY/);
  });
  it("parses LOG_ONLY=true", () => {
    expect(loadConfig({ ...FULL, LOG_ONLY: "true" }).logOnly).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL — cannot find module `./config.js`.

- [ ] **Step 4: Write `src/config.ts`**

```ts
export interface Config {
  projectId: string;
  projectNumber: string;
  geminiApiKey: string;
  geminiModel: string;
  oauthClientId: string;
  oauthClientSecret: string;
  apiSecret: string;
  userEmail: string;
  logOnly: boolean;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const req = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`missing env var ${k}`);
    return v;
  };
  return {
    projectId: req("GCP_PROJECT_ID"),
    projectNumber: req("GCP_PROJECT_NUMBER"),
    geminiApiKey: req("GEMINI_API_KEY"),
    geminiModel: env.GEMINI_MODEL ?? "gemini-2.5-flash",
    oauthClientId: req("OAUTH_CLIENT_ID"),
    oauthClientSecret: req("OAUTH_CLIENT_SECRET"),
    apiSecret: req("API_SECRET"),
    userEmail: req("USER_EMAIL"),
    logOnly: env.LOG_ONLY === "true",
  };
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "add types and config loader"
```

---

### Task 3: Context window builder

**Files:**
- Create: `src/context.ts`
- Test: `src/context.test.ts`

**Interfaces:**
- Consumes: `ContextMessage` from `types.ts`
- Produces: `buildContextWindow(messages: ContextMessage[], trigger: ContextMessage): ContextMessage[]` — chronological slice ending at the trigger, applying the "5 messages or 30 minutes, whichever is more" rule. Quoted content travels *inside* each `ContextMessage.quoted`, so no extra handling here.

- [ ] **Step 1: Write failing test `src/context.test.ts`**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/context.ts`**

```ts
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
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "add context window builder"
```

---

### Task 4: Classifier — prompt, parser, Gemini call

**Files:**
- Create: `src/classifier.ts`
- Test: `src/classifier.test.ts`

**Interfaces:**
- Consumes: `ClassifierInput`, `Classification` from `types.ts`; `Config` from `config.ts`
- Produces:
  - `buildPrompt(input: ClassifierInput): string` (pure)
  - `parseClassification(raw: string): Classification` (pure, throws on invalid)
  - `classify(input: ClassifierInput, cfg: Config): Promise<Classification>` (calls Gemini with JSON response schema)

- [ ] **Step 1: Write failing test `src/classifier.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { buildPrompt, parseClassification } from "./classifier.js";
import type { ClassifierInput } from "./types.js";

const input: ClassifierInput = {
  spaceId: "spaces/A",
  nowIst: "2026-07-18T14:30:00+05:30",
  trigger: {
    messageId: "spaces/A/messages/2", sender: "them", senderName: "Rahul",
    text: "isko dekh lena jab free ho",
    createTime: "2026-07-18T14:29:00+05:30",
    quoted: { senderName: "Rahul", text: "login page pe error aa raha hai" },
  },
  context: [
    { messageId: "spaces/A/messages/1", sender: "me", senderName: "Shaqeeb",
      text: "haan bolo", createTime: "2026-07-18T14:25:00+05:30" },
    { messageId: "spaces/A/messages/2", sender: "them", senderName: "Rahul",
      text: "isko dekh lena jab free ho",
      createTime: "2026-07-18T14:29:00+05:30",
      quoted: { senderName: "Rahul", text: "login page pe error aa raha hai" } },
  ],
};

describe("buildPrompt", () => {
  it("includes quoted text, senders, current date, and the trigger marker", () => {
    const p = buildPrompt(input);
    expect(p).toContain("login page pe error aa raha hai"); // quoted content present
    expect(p).toContain("Rahul");
    expect(p).toContain("2026-07-18");
    expect(p).toContain(">>>"); // trigger message is marked
  });
});

describe("parseClassification", () => {
  it("accepts a valid task response", () => {
    const c = parseClassification(JSON.stringify({
      verdict: "task", title: "Fix error on login page", dueDate: null,
      requester: "Rahul", confidence: 0.9, reasoning: "explicit ask",
    }));
    expect(c.verdict).toBe("task");
    expect(c.title).toBe("Fix error on login page");
  });
  it("rejects an unknown verdict", () => {
    expect(() => parseClassification(JSON.stringify({
      verdict: "maybe", title: null, dueDate: null, requester: null,
      confidence: 0.5, reasoning: "",
    }))).toThrow(/verdict/);
  });
  it("rejects a bad dueDate format", () => {
    expect(() => parseClassification(JSON.stringify({
      verdict: "task", title: "t", dueDate: "tomorrow", requester: null,
      confidence: 0.5, reasoning: "",
    }))).toThrow(/dueDate/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/classifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/classifier.ts`**

```ts
import { GoogleGenAI, Type } from "@google/genai";
import type { ClassifierInput, Classification, Verdict } from "./types.js";
import type { Config } from "./config.js";

const VERDICTS: Verdict[] = ["not_task", "task", "task_incomplete"];

export function buildPrompt(input: ClassifierInput): string {
  const lines = input.context.map((m) => {
    const who = m.sender === "me" ? `ME (${m.senderName})` : m.senderName;
    const quoted = m.quoted
      ? `\n   [quoting ${m.quoted.senderName}: "${m.quoted.text}"]`
      : "";
    const marker = m.messageId === input.trigger.messageId ? ">>> " : "    ";
    return `${marker}[${m.createTime}] ${who}: ${m.text}${quoted}`;
  });
  return `You are TaskLens, a task detector for a software developer's Google Chat DMs.
Messages may be in English, Hindi, or Hinglish (code-mixed).
Today's date/time in IST is ${input.nowIst}.

Below is a DM conversation. The message marked with ">>>" is the one to classify.
Lines starting with "ME" were written by the user themself — they are context,
never tasks for the user.

${lines.join("\n")}

Classify the ">>>" message:
- "task": someone is asking the user to do something, and there is enough detail
  to state what the work is. Examples of task phrasing: "isko dekh lena",
  "kal tak chahiye", "please fix this", "jab free ho tab kar dena",
  "change this word to that".
- "task_incomplete": it is clearly a request, but a person could NOT act on it
  yet — the what/where is missing (e.g. "change the word to this" with no file
  or page named anywhere in the context).
- "not_task": conversation, questions, FYI, status updates, greetings.

Rules:
- Derive the title from the WHOLE context (especially quoted messages), not just
  the ">>>" line. "isko dekh lena" quoting "login page pe error" =>
  title "Fix error on login page".
- dueDate: resolve relative dates against today's IST date ("kal tak" =>
  tomorrow, "EOD" => today). Format YYYY-MM-DD. null if no deadline given.
- requester: the display name of the person asking.
- When unsure between not_task and task, lean toward task.
- Write title and reasoning in English.`;
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    verdict: { type: Type.STRING, enum: VERDICTS as string[] },
    title: { type: Type.STRING, nullable: true },
    dueDate: { type: Type.STRING, nullable: true },
    requester: { type: Type.STRING, nullable: true },
    confidence: { type: Type.NUMBER },
    reasoning: { type: Type.STRING },
  },
  required: ["verdict", "title", "dueDate", "requester", "confidence", "reasoning"],
};

export function parseClassification(raw: string): Classification {
  const o = JSON.parse(raw);
  if (!VERDICTS.includes(o.verdict)) throw new Error(`invalid verdict: ${o.verdict}`);
  if (o.dueDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(o.dueDate))
    throw new Error(`invalid dueDate: ${o.dueDate}`);
  return {
    verdict: o.verdict,
    title: o.title ?? null,
    dueDate: o.dueDate ?? null,
    requester: o.requester ?? null,
    confidence: typeof o.confidence === "number" ? o.confidence : 0,
    reasoning: String(o.reasoning ?? ""),
  };
}

export async function classify(
  input: ClassifierInput,
  cfg: Config,
): Promise<Classification> {
  const ai = new GoogleGenAI({ apiKey: cfg.geminiApiKey });
  const res = await ai.models.generateContent({
    model: cfg.geminiModel,
    contents: buildPrompt(input),
    config: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
  });
  return parseClassification(res.text ?? "{}");
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run`
Expected: all pass. (`classify` itself is exercised in Task 5 against the real API.)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "add gemini classifier"
```

---

### Task 5: Classifier validation harness — THE PHASE-1 GATE

**Files:**
- Create: `scripts/validate-classifier.ts`, `samples/messages.example.jsonl`

**Interfaces:**
- Consumes: `classify`, `buildPrompt` from `classifier.ts`; `loadConfig`
- Produces: a CLI report (per-sample table + accuracy) used to tune the prompt. **No further task should be started until this gate passes.**

- [ ] **Step 1: Create `samples/messages.example.jsonl`** (committed template; the real `samples/messages.jsonl` is gitignored)

```jsonl
{"text":"isko dekh lena jab free ho","quoted":"login page pe error aa raha hai","prior":[],"expected":"task"}
{"text":"kal tak yeh changes chahiye","quoted":null,"prior":["PR #42 review ho gaya"],"expected":"task"}
{"text":"lunch chalein?","quoted":null,"prior":[],"expected":"not_task"}
{"text":"change the word to this","quoted":null,"prior":[],"expected":"task_incomplete"}
{"text":"done hai woh wala","quoted":null,"prior":[],"expected":"not_task"}
```

- [ ] **Step 2: Write `scripts/validate-classifier.ts`**

```ts
import { readFileSync } from "node:fs";
import { classify } from "../src/classifier.js";
import { loadConfig } from "../src/config.js";
import type { ClassifierInput, ContextMessage, Verdict } from "../src/types.js";

interface Sample { text: string; quoted: string | null; prior: string[]; expected: Verdict; }

const file = process.argv[2] ?? "samples/messages.jsonl";
const samples: Sample[] = readFileSync(file, "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const cfg = loadConfig();

function toInput(s: Sample, i: number): ClassifierInput {
  const base = Date.now();
  const mk = (text: string, j: number, last: boolean): ContextMessage => ({
    messageId: `spaces/S/messages/${i}-${j}`,
    sender: "them", senderName: "Colleague", text,
    createTime: new Date(base - (10 - j) * 60_000).toISOString(),
    ...(last && s.quoted ? { quoted: { senderName: "Colleague", text: s.quoted } } : {}),
  });
  const context = [...s.prior.map((t, j) => mk(t, j, false)), mk(s.text, s.prior.length, true)];
  return { spaceId: "spaces/S", trigger: context[context.length - 1], context,
    nowIst: new Date().toISOString() };
}

let correct = 0;
for (let i = 0; i < samples.length; i++) {
  const s = samples[i];
  const c = await classify(toInput(s, i), cfg);
  const ok = c.verdict === s.expected;
  if (ok) correct++;
  console.log(`${ok ? "✅" : "❌"} expected=${s.expected} got=${c.verdict} ` +
    `conf=${c.confidence.toFixed(2)} title=${JSON.stringify(c.title)} | ${s.text}`);
  if (!ok) console.log(`   reasoning: ${c.reasoning}`);
}
console.log(`\n${correct}/${samples.length} correct (${Math.round((correct / samples.length) * 100)}%)`);
const missedTasks = samples.filter((s, i) => s.expected !== "not_task").length;
console.log(`gate: EVERY expected task/task_incomplete must be detected; false positives are tolerable.`);
```

- [ ] **Step 3: USER ACTION — collect real samples**

The user copies ~30 real messages from their chat history into `samples/messages.jsonl` (same shape as the example file): a mix of clear tasks, non-tasks, Hinglish, quoted-message tasks, and multi-message incomplete tasks. Also set `GEMINI_API_KEY` in `.env`.

- [ ] **Step 4: Run the harness and tune**

Run: `npm run validate`
Expected gate: **zero missed tasks** (`task`/`task_incomplete` misclassified as `not_task`); false positives acceptable if under ~20%. If the gate fails, edit the prompt in `buildPrompt` (add failing samples as few-shot examples) and re-run until it passes. **Do not proceed to Task 6 until this passes.**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "add classifier validation harness"
```

---

### Task 6: Firestore store

**Files:**
- Create: `src/store.ts`
- Test: `src/store.test.ts`

**Interfaces:**
- Consumes: `Detection`, `DetectionStatus` from `types.ts`
- Produces: `class Store` with:
  - `constructor(db: FirestoreLike)` — accepts the real `Firestore` or the in-memory fake
  - `getLastSeen(spaceId): Promise<string | null>` / `setLastSeen(spaceId, iso): Promise<void>`
  - `isProcessed(messageId): Promise<boolean>` / `markProcessed(messageId): Promise<void>`
  - `saveDetection(d: Detection): Promise<void>` / `updateDetection(id, patch: Partial<Detection>): Promise<void>` / `getDetection(id): Promise<Detection | null>`
  - `listByStatus(status: DetectionStatus): Promise<Detection[]>`
  - `listOpenIncomplete(spaceId): Promise<Detection[]>`
  - `listConfirmedSince(iso): Promise<Detection[]>`
  - `getAuthTokens(): Promise<{refreshToken: string} | null>` / `setAuthTokens(t): Promise<void>`
  - `docId(messageId: string): string` (static, pure: replaces `/` with `_`)
- Also exports `FirestoreLike` (minimal interface) and `makeFakeDb(): FirestoreLike` for tests.

- [ ] **Step 1: Write failing test `src/store.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Store, makeFakeDb } from "./store.js";
import type { Detection } from "./types.js";

function det(id: string, over: Partial<Detection> = {}): Detection {
  return {
    id, spaceId: "spaces/A", messageIds: [id], contextSnapshot: [],
    verdict: "task", title: "t", dueDate: null, requester: "R",
    status: "pending", sourceLink: "https://chat.google.com/x",
    createdAt: "2026-07-18T10:00:00Z", updatedAt: "2026-07-18T10:00:00Z",
    ...over,
  };
}

describe("Store", () => {
  let store: Store;
  beforeEach(() => { store = new Store(makeFakeDb()); });

  it("round-trips lastSeen cursor", async () => {
    expect(await store.getLastSeen("spaces/A")).toBeNull();
    await store.setLastSeen("spaces/A", "2026-07-18T10:00:00Z");
    expect(await store.getLastSeen("spaces/A")).toBe("2026-07-18T10:00:00Z");
  });
  it("dedupes processed messages", async () => {
    expect(await store.isProcessed("spaces/A/messages/1")).toBe(false);
    await store.markProcessed("spaces/A/messages/1");
    expect(await store.isProcessed("spaces/A/messages/1")).toBe(true);
  });
  it("saves, updates and queries detections by status", async () => {
    await store.saveDetection(det("d1"));
    await store.saveDetection(det("d2", { status: "incomplete" }));
    expect((await store.listByStatus("pending")).map((d) => d.id)).toEqual(["d1"]);
    await store.updateDetection("d1", { status: "confirmed" });
    expect((await store.getDetection("d1"))?.status).toBe("confirmed");
  });
  it("lists open incompletes for a space only", async () => {
    await store.saveDetection(det("d1", { status: "incomplete", spaceId: "spaces/A" }));
    await store.saveDetection(det("d2", { status: "incomplete", spaceId: "spaces/B" }));
    expect((await store.listOpenIncomplete("spaces/A")).map((d) => d.id)).toEqual(["d1"]);
  });
  it("sanitizes doc ids", () => {
    expect(Store.docId("spaces/A/messages/B")).toBe("spaces_A_messages_B");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/store.ts`**

```ts
import type { Detection, DetectionStatus } from "./types.js";

// Minimal slice of the Firestore API we use — lets tests run on an in-memory fake.
export interface DocLike {
  get(): Promise<{ exists: boolean; data(): any }>;
  set(data: any): Promise<unknown>;
  update(patch: any): Promise<unknown>;
}
export interface CollectionLike {
  doc(id: string): DocLike;
  where(field: string, op: "==" | ">=", value: any): {
    get(): Promise<{ docs: Array<{ data(): any }> }>;
    where(field: string, op: "==" | ">=", value: any): {
      get(): Promise<{ docs: Array<{ data(): any }> }>;
    };
  };
}
export interface FirestoreLike { collection(name: string): CollectionLike; }

export class Store {
  constructor(private db: FirestoreLike) {}

  static docId(messageId: string): string { return messageId.replace(/\//g, "_"); }

  async getLastSeen(spaceId: string): Promise<string | null> {
    const snap = await this.db.collection("spaces").doc(Store.docId(spaceId)).get();
    return snap.exists ? (snap.data().lastSeen ?? null) : null;
  }
  async setLastSeen(spaceId: string, iso: string): Promise<void> {
    await this.db.collection("spaces").doc(Store.docId(spaceId)).set({ spaceId, lastSeen: iso });
  }

  async isProcessed(messageId: string): Promise<boolean> {
    return (await this.db.collection("processed").doc(Store.docId(messageId)).get()).exists;
  }
  async markProcessed(messageId: string): Promise<void> {
    await this.db.collection("processed").doc(Store.docId(messageId)).set({ messageId });
  }

  async saveDetection(d: Detection): Promise<void> {
    await this.db.collection("detections").doc(d.id).set(d);
  }
  async updateDetection(id: string, patch: Partial<Detection>): Promise<void> {
    await this.db.collection("detections").doc(id).update(patch);
  }
  async getDetection(id: string): Promise<Detection | null> {
    const snap = await this.db.collection("detections").doc(id).get();
    return snap.exists ? (snap.data() as Detection) : null;
  }
  async listByStatus(status: DetectionStatus): Promise<Detection[]> {
    const r = await this.db.collection("detections").where("status", "==", status).get();
    return r.docs.map((d) => d.data() as Detection);
  }
  async listOpenIncomplete(spaceId: string): Promise<Detection[]> {
    const r = await this.db.collection("detections")
      .where("status", "==", "incomplete").where("spaceId", "==", spaceId).get();
    return r.docs.map((d) => d.data() as Detection);
  }
  async listConfirmedSince(iso: string): Promise<Detection[]> {
    const r = await this.db.collection("detections")
      .where("status", "==", "confirmed").where("updatedAt", ">=", iso).get();
    return r.docs.map((d) => d.data() as Detection);
  }

  async getAuthTokens(): Promise<{ refreshToken: string } | null> {
    const snap = await this.db.collection("auth").doc("user").get();
    return snap.exists ? (snap.data() as { refreshToken: string }) : null;
  }
  async setAuthTokens(t: { refreshToken: string }): Promise<void> {
    await this.db.collection("auth").doc("user").set(t);
  }
}

/** In-memory FirestoreLike for tests. */
export function makeFakeDb(): FirestoreLike {
  const data = new Map<string, Map<string, any>>();
  const col = (name: string) => data.get(name) ?? data.set(name, new Map()).get(name)!;
  const runFilters = (name: string, filters: Array<[string, string, any]>) => ({
    docs: [...col(name).values()]
      .filter((d) => filters.every(([f, op, v]) => (op === "==" ? d[f] === v : d[f] >= v)))
      .map((d) => ({ data: () => d })),
  });
  return {
    collection(name: string): CollectionLike {
      return {
        doc(id: string): DocLike {
          return {
            async get() {
              const d = col(name).get(id);
              return { exists: d !== undefined, data: () => d };
            },
            async set(v: any) { col(name).set(id, v); },
            async update(patch: any) {
              const cur = col(name).get(id);
              if (cur === undefined) throw new Error(`no doc ${name}/${id}`);
              col(name).set(id, { ...cur, ...patch });
            },
          };
        },
        where(f: string, op: any, v: any) {
          const filters: Array<[string, string, any]> = [[f, op, v]];
          return {
            get: async () => runFilters(name, filters),
            where(f2: string, op2: any, v2: any) {
              filters.push([f2, op2, v2]);
              return { get: async () => runFilters(name, filters) };
            },
          };
        },
      };
    },
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "add firestore store"
```

Note for deployment (Task 16): `listConfirmedSince` uses a composite filter (`status` + `updatedAt`) — Firestore will log a link to auto-create the required composite index the first time it runs; follow that link.

---

### Task 7: Chat API wrapper

**Files:**
- Create: `src/chat.ts`
- Test: `src/chat.test.ts`

**Interfaces:**
- Consumes: `Config`, `Store` (for the user refresh token), `ContextMessage`
- Produces: `class ChatClient` with:
  - `static async forUser(cfg: Config, store: Store): Promise<ChatClient>` — builds an OAuth2 user client from the stored refresh token
  - `listDmSpaces(): Promise<string[]>` — DM space resource names
  - `fetchMessagesSince(spaceId: string, sinceIso: string, myEmailName: string): Promise<ContextMessage[]>` — chronological, quoted messages resolved inline, `sender` set by comparing the sender resource name to the authed user
  - `sendAppDm(cfg: Config, body: object): Promise<void>` (static) — sends a message/card to the user's DM with the app using **app** (ADC service-account) credentials
- Also exports `toContextMessage(raw, myUserName): ContextMessage` (pure) for testability.

- [ ] **Step 1: Write failing test `src/chat.test.ts`** (tests the pure mapper; API plumbing is verified live in Step 5)

```ts
import { describe, it, expect } from "vitest";
import { toContextMessage } from "./chat.js";

const raw = {
  name: "spaces/A/messages/B",
  sender: { name: "users/111", displayName: "Rahul" },
  text: "isko dekh lena",
  createTime: "2026-07-18T09:00:00Z",
  quotedMessageMetadata: {
    quotedMessage: {
      sender: { displayName: "Rahul" },
      text: "login page pe error hai",
    },
  },
};

describe("toContextMessage", () => {
  it("maps fields and resolves the quote inline", () => {
    const m = toContextMessage(raw as any, "users/999");
    expect(m.messageId).toBe("spaces/A/messages/B");
    expect(m.sender).toBe("them");
    expect(m.quoted?.text).toBe("login page pe error hai");
  });
  it("marks my own messages as me", () => {
    const mine = { ...raw, sender: { name: "users/999", displayName: "Shaqeeb" } };
    expect(toContextMessage(mine as any, "users/999").sender).toBe("me");
  });
  it("handles missing text and no quote", () => {
    const bare = { name: "spaces/A/messages/C", sender: { name: "users/111", displayName: "R" },
      createTime: "2026-07-18T09:00:00Z" };
    const m = toContextMessage(bare as any, "users/999");
    expect(m.text).toBe("");
    expect(m.quoted).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/chat.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/chat.ts`**

```ts
import { google, chat_v1 } from "googleapis";
import { OAuth2Client, GoogleAuth } from "google-auth-library";
import type { Config } from "./config.js";
import type { Store } from "./store.js";
import type { ContextMessage } from "./types.js";

export function toContextMessage(
  raw: chat_v1.Schema$Message,
  myUserName: string,
): ContextMessage {
  const q = raw.quotedMessageMetadata?.quotedMessage;
  return {
    messageId: raw.name ?? "",
    sender: raw.sender?.name === myUserName ? "me" : "them",
    senderName: raw.sender?.displayName ?? "Unknown",
    text: raw.text ?? "",
    createTime: raw.createTime ?? "",
    ...(q ? { quoted: { senderName: q.sender?.displayName ?? "Unknown", text: q.text ?? "" } } : {}),
  };
}

export function sourceLinkFor(messageId: string): string {
  // spaces/AAA/messages/BBB -> https://chat.google.com/room/AAA/BBB
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
    // Resolve own user resource name once, via any DM membership list is overkill;
    // Chat API has no "me" endpoint, so match by email on message senders is unreliable.
    // Instead: the People API route is more setup. Pragmatic v1: store it after first
    // poll by finding the sender that appears in ALL DM spaces is fragile too.
    // Simplest robust approach: users/{email} works as an alias in Chat API.
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
        // sender.name is users/<id>, not users/<email>; resolve "me" by id alias:
        // Chat API accepts users/{email} lookups, but sender names come as ids.
        // We mark "me" when the sender id matches the id we see on our own sent
        // messages — cheap heuristic: compare displayName-less identity via
        // message.sender.type === "HUMAN" plus isFromMe flag is not exposed, so
        // we compare against myUserName resolved at auth time AND fall back to
        // email alias equality.
        out.push(toContextMessage(raw, this.myUserName));
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  /** Send a message/card from the APP to the user's DM with the app (ADC creds). */
  static async sendAppDm(cfg: Config, body: object): Promise<void> {
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/chat.bot"] });
    const api = google.chat({ version: "v1", auth });
    const dm = await api.spaces.findDirectMessage({ name: `users/${cfg.userEmail}` });
    if (!dm.data.name) throw new Error("app has no DM with user — message the app once in chat");
    await api.spaces.messages.create({ parent: dm.data.name, requestBody: body });
  }
}
```

**Known wrinkle (documented on purpose):** message `sender.name` arrives as `users/<numeric id>`, while we construct `users/<email>`. During Task 15's live auth test, print one of your own messages and one of theirs; if `sender` comes out wrong, store your numeric user id in Firestore (`auth/user.userName`) during `auth-setup` (fetch via `spaces.members.list` on any DM and match by `member.name` whose DM is 1:1 with you) and pass that to `toContextMessage`. The mapper signature already supports this — only the resolved value changes.

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "add chat api wrapper"
```

---

### Task 8: Cards and digest builders

**Files:**
- Create: `src/cards.ts`
- Test: `src/cards.test.ts`

**Interfaces:**
- Consumes: `Detection`
- Produces (all pure):
  - `confirmationCard(d: Detection, unclear?: boolean): object` — Chat `cardsV2` message body with ✅/❌ buttons whose click actions carry `{ detectionId }`; `unclear=true` prefixes "possible task, details unclear"
  - `digestMessage(created: Detection[], pending: Detection[], unresolved: Detection[]): object` — plain-text Chat message body
  - Button action function names (contract with Task 12): `"confirm_task"` and `"dismiss_task"`

- [ ] **Step 1: Write failing test `src/cards.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { confirmationCard, digestMessage } from "./cards.js";
import type { Detection } from "./types.js";

const d: Detection = {
  id: "spaces_A_messages_B", spaceId: "spaces/A", messageIds: ["spaces/A/messages/B"],
  contextSnapshot: [], verdict: "task", title: "Fix error on login page",
  dueDate: "2026-07-19", requester: "Rahul", status: "pending",
  sourceLink: "https://chat.google.com/room/A/B",
  createdAt: "2026-07-18T10:00:00Z", updatedAt: "2026-07-18T10:00:00Z",
};

describe("confirmationCard", () => {
  it("contains title, requester, due date, source link and both buttons", () => {
    const s = JSON.stringify(confirmationCard(d));
    expect(s).toContain("Fix error on login page");
    expect(s).toContain("Rahul");
    expect(s).toContain("2026-07-19");
    expect(s).toContain(d.sourceLink);
    expect(s).toContain("confirm_task");
    expect(s).toContain("dismiss_task");
    expect(s).toContain(d.id); // detectionId travels in button parameters
  });
  it("marks unclear detections", () => {
    const s = JSON.stringify(confirmationCard(d, true));
    expect(s.toLowerCase()).toContain("details unclear");
  });
});

describe("digestMessage", () => {
  it("lists created, pending and unresolved sections", () => {
    const msg = digestMessage([d], [{ ...d, id: "p1", title: "Update pricing copy" }], []);
    const s = JSON.stringify(msg);
    expect(s).toContain("Fix error on login page");
    expect(s).toContain("Update pricing copy");
  });
  it("says all clear when empty", () => {
    const s = JSON.stringify(digestMessage([], [], []));
    expect(s.toLowerCase()).toContain("all clear");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cards.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/cards.ts`**

```ts
import type { Detection } from "./types.js";

export function confirmationCard(d: Detection, unclear = false): object {
  const header = unclear ? "🤔 Possible task, details unclear" : "📋 Task detected";
  const widgets: object[] = [
    { decoratedText: { topLabel: "Task", text: d.title ?? "(no title)", wrapText: true } },
    { decoratedText: { topLabel: "From", text: d.requester ?? "Unknown" } },
  ];
  if (d.dueDate) widgets.push({ decoratedText: { topLabel: "Due", text: d.dueDate } });
  widgets.push({
    buttonList: {
      buttons: [
        {
          text: "✅ Create task",
          onClick: { action: { function: "confirm_task",
            parameters: [{ key: "detectionId", value: d.id }] } },
        },
        {
          text: "❌ Not a task",
          onClick: { action: { function: "dismiss_task",
            parameters: [{ key: "detectionId", value: d.id }] } },
        },
        { text: "Open message", onClick: { openLink: { url: d.sourceLink } } },
      ],
    },
  });
  return {
    cardsV2: [{
      cardId: d.id,
      card: { header: { title: header }, sections: [{ widgets }] },
    }],
  };
}

const line = (d: Detection) =>
  `• ${d.title ?? "(no title)"}${d.dueDate ? ` (due ${d.dueDate})` : ""} — ${d.requester ?? "?"}`;

export function digestMessage(
  created: Detection[], pending: Detection[], unresolved: Detection[],
): object {
  if (!created.length && !pending.length && !unresolved.length)
    return { text: "☀️ Morning digest: all clear — no tasks captured yesterday, nothing pending." };
  const parts: string[] = ["☀️ *Morning digest*"];
  if (created.length) parts.push(`\n*Created yesterday:*\n${created.map(line).join("\n")}`);
  if (pending.length)
    parts.push(`\n*Still awaiting your ✅/❌:*\n${pending.map(line).join("\n")}`);
  if (unresolved.length)
    parts.push(`\n*Unclear, never resolved:*\n${unresolved.map(line).join("\n")}`);
  return { text: parts.join("\n") };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "add confirmation card and digest builders"
```

---

### Task 9: Detection lifecycle logic

**Files:**
- Create: `src/lifecycle.ts`
- Test: `src/lifecycle.test.ts`

**Interfaces:**
- Consumes: `ClassifierInput`, `Classification`, `Detection`
- Produces (all pure):
  - `makeDetection(input: ClassifierInput, c: Classification, nowIso: string): Detection` — status `pending` for verdict `task`, `incomplete` for `task_incomplete`; `sourceLink` built via `sourceLinkFor` from `chat.ts`
  - `mergeIncomplete(existing: Detection, newContext: ContextMessage[], c: Classification, nowIso: string): Detection` — appends new message ids/context, applies new classification; flips status to `pending` when verdict becomes `task`
  - `isExpired(d: Detection, nowIso: string): boolean` — true when status `incomplete` and `createdAt` > 2 hours before `nowIso`

- [ ] **Step 1: Write failing test `src/lifecycle.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { makeDetection, mergeIncomplete, isExpired } from "./lifecycle.js";
import type { ClassifierInput, Classification } from "./types.js";

const input: ClassifierInput = {
  spaceId: "spaces/A", nowIst: "2026-07-18T14:30:00+05:30",
  trigger: { messageId: "spaces/A/messages/B", sender: "them", senderName: "Rahul",
    text: "change the word to this", createTime: "2026-07-18T14:29:00+05:30" },
  context: [{ messageId: "spaces/A/messages/B", sender: "them", senderName: "Rahul",
    text: "change the word to this", createTime: "2026-07-18T14:29:00+05:30" }],
};
const task: Classification = { verdict: "task", title: "Change wording on pricing page",
  dueDate: null, requester: "Rahul", confidence: 0.9, reasoning: "" };
const incomplete: Classification = { ...task, verdict: "task_incomplete", title: null };

describe("makeDetection", () => {
  it("creates pending for task verdict", () => {
    const d = makeDetection(input, task, "2026-07-18T09:00:00Z");
    expect(d.status).toBe("pending");
    expect(d.id).toBe("spaces_A_messages_B");
    expect(d.sourceLink).toContain("chat.google.com");
  });
  it("creates incomplete for task_incomplete verdict", () => {
    expect(makeDetection(input, incomplete, "2026-07-18T09:00:00Z").status).toBe("incomplete");
  });
});

describe("mergeIncomplete", () => {
  it("flips to pending once classification resolves", () => {
    const d = makeDetection(input, incomplete, "2026-07-18T09:00:00Z");
    const newMsg = { messageId: "spaces/A/messages/C", sender: "them" as const,
      senderName: "Rahul", text: "pricing page pe, 'cheap' ko 'affordable' karo",
      createTime: "2026-07-18T14:35:00+05:30" };
    const merged = mergeIncomplete(d, [newMsg], task, "2026-07-18T09:10:00Z");
    expect(merged.status).toBe("pending");
    expect(merged.title).toBe("Change wording on pricing page");
    expect(merged.messageIds).toContain("spaces/A/messages/C");
  });
  it("stays incomplete when still unresolved", () => {
    const d = makeDetection(input, incomplete, "2026-07-18T09:00:00Z");
    const merged = mergeIncomplete(d, [], incomplete, "2026-07-18T09:10:00Z");
    expect(merged.status).toBe("incomplete");
  });
});

describe("isExpired", () => {
  const d = makeDetection(input, incomplete, "2026-07-18T09:00:00Z");
  it("false before 2h", () => expect(isExpired(d, "2026-07-18T10:59:00Z")).toBe(false));
  it("true after 2h", () => expect(isExpired(d, "2026-07-18T11:01:00Z")).toBe(true));
  it("never expires pending detections", () => {
    expect(isExpired({ ...d, status: "pending" }, "2026-07-19T09:00:00Z")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lifecycle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/lifecycle.ts`**

```ts
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
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "add detection lifecycle logic"
```

---

### Task 10: Google Tasks client

**Files:**
- Create: `src/tasks.ts`
- Test: `src/tasks.test.ts`

**Interfaces:**
- Consumes: `Detection`, `Config`, `Store`
- Produces:
  - `taskPayload(d: Detection): { title: string; notes: string; due?: string }` (pure) — `due` is RFC3339 midnight UTC of `dueDate`
  - `createTask(d: Detection, cfg: Config, store: Store): Promise<void>` — inserts into the user's default task list (`@default`) with the user OAuth client (same token as chat reads; `tasks` scope was granted in auth-setup)

- [ ] **Step 1: Write failing test `src/tasks.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { taskPayload } from "./tasks.js";
import type { Detection } from "./types.js";

const d: Detection = {
  id: "x", spaceId: "spaces/A", messageIds: ["spaces/A/messages/B"],
  contextSnapshot: [], verdict: "task", title: "Fix error on login page",
  dueDate: "2026-07-19", requester: "Rahul", status: "pending",
  sourceLink: "https://chat.google.com/room/A/B",
  createdAt: "2026-07-18T10:00:00Z", updatedAt: "2026-07-18T10:00:00Z",
};

describe("taskPayload", () => {
  it("builds title, notes with requester + link, and RFC3339 due", () => {
    const p = taskPayload(d);
    expect(p.title).toBe("Fix error on login page");
    expect(p.notes).toContain("Rahul");
    expect(p.notes).toContain(d.sourceLink);
    expect(p.due).toBe("2026-07-19T00:00:00.000Z");
  });
  it("omits due when no deadline", () => {
    expect(taskPayload({ ...d, dueDate: null }).due).toBeUndefined();
  });
  it("falls back to a title when null", () => {
    expect(taskPayload({ ...d, title: null }).title).toContain("Task from Rahul");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tasks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/tasks.ts`**

```ts
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
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "add google tasks client"
```

---

### Task 11: Poll orchestrator

**Files:**
- Create: `src/poll.ts`
- Test: `src/poll.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–9. Dependencies are injected so tests use fakes:
- Produces:
  - `interface PollDeps { chat: { listDmSpaces(): Promise<string[]>; fetchMessagesSince(s: string, since: string): Promise<ContextMessage[]> }; classify(input: ClassifierInput): Promise<Classification>; store: Store; sendDm(body: object): Promise<void>; now(): string; logOnly: boolean; }`
  - `runPoll(deps: PollDeps): Promise<{ classified: number; pinged: number }>`

Behavior contract (each bullet is a test):
1. New message from **them**, verdict `task` → save `pending` detection, send confirmation card, mark processed.
2. Verdict `not_task` → mark processed, nothing saved/sent.
3. My own messages are never classified but do appear in windows.
4. Already-processed messages are skipped (dedupe).
5. Verdict `task_incomplete` → save `incomplete`, **no card sent**.
6. Open incomplete in a space + any new messages → re-classify with merged context; if resolved → update to `pending` + send card.
7. Incomplete older than 2h → status `expired`... **no** — spec says ping as "details unclear": flip to `pending`, send `confirmationCard(d, true)`.
8. `lastSeen` cursor advances to the newest message's `createTime`; first-ever poll defaults to 24h back.
9. `logOnly: true` → everything happens except `sendDm`.

- [ ] **Step 1: Write failing test `src/poll.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { runPoll, type PollDeps } from "./poll.js";
import { Store, makeFakeDb } from "./store.js";
import type { Classification, ContextMessage } from "./types.js";

const NOW = "2026-07-18T09:30:00.000Z";
function m(id: string, sender: "me" | "them", text: string, iso = "2026-07-18T09:20:00.000Z"): ContextMessage {
  return { messageId: `spaces/A/messages/${id}`, sender,
    senderName: sender === "me" ? "Shaqeeb" : "Rahul", text, createTime: iso };
}
const TASK: Classification = { verdict: "task", title: "Fix login error", dueDate: null,
  requester: "Rahul", confidence: 0.9, reasoning: "" };
const NOT: Classification = { ...TASK, verdict: "not_task", title: null };
const INC: Classification = { ...TASK, verdict: "task_incomplete", title: null };

function makeDeps(msgs: ContextMessage[], verdicts: Classification[]): PollDeps & { sent: object[] } {
  const store = new Store(makeFakeDb());
  const sent: object[] = [];
  let i = 0;
  return {
    chat: {
      listDmSpaces: async () => ["spaces/A"],
      fetchMessagesSince: async () => msgs,
    },
    classify: async () => verdicts[i++] ?? NOT,
    store, sent,
    sendDm: async (b: object) => { sent.push(b); },
    now: () => NOW,
    logOnly: false,
  };
}

describe("runPoll", () => {
  it("saves pending detection and sends card for a task", async () => {
    const deps = makeDeps([m("1", "them", "isko dekh lena")], [TASK]);
    const r = await runPoll(deps);
    expect(r.pinged).toBe(1);
    expect((await deps.store.listByStatus("pending"))).toHaveLength(1);
    expect(deps.sent).toHaveLength(1);
  });
  it("ignores not_task but still dedupes", async () => {
    const deps = makeDeps([m("1", "them", "lunch?")], [NOT]);
    await runPoll(deps);
    expect(deps.sent).toHaveLength(0);
    expect(await deps.store.isProcessed("spaces/A/messages/1")).toBe(true);
  });
  it("never classifies my own messages", async () => {
    const deps = makeDeps([m("1", "me", "haan kar dunga")], [TASK]);
    const r = await runPoll(deps);
    expect(r.classified).toBe(0);
  });
  it("skips already-processed messages", async () => {
    const deps = makeDeps([m("1", "them", "isko dekh lena")], [TASK, TASK]);
    await runPoll(deps);
    await runPoll(deps);
    expect(deps.sent).toHaveLength(1);
  });
  it("holds incomplete without sending a card", async () => {
    const deps = makeDeps([m("1", "them", "change the word to this")], [INC]);
    await runPoll(deps);
    expect(deps.sent).toHaveLength(0);
    expect(await deps.store.listOpenIncomplete("spaces/A")).toHaveLength(1);
  });
  it("resolves an open incomplete when new context arrives", async () => {
    const deps = makeDeps([m("1", "them", "change the word to this")], [INC, TASK, NOT]);
    await runPoll(deps);
    // second poll: clarification arrives
    deps.chat.fetchMessagesSince = async () =>
      [m("2", "them", "pricing page pe 'cheap' ko 'affordable'", "2026-07-18T09:25:00.000Z")];
    await runPoll(deps);
    expect(deps.sent).toHaveLength(1);
    expect(await deps.store.listByStatus("pending")).toHaveLength(1);
    expect(await deps.store.listOpenIncomplete("spaces/A")).toHaveLength(0);
  });
  it("pings expired incompletes as unclear", async () => {
    const deps = makeDeps([m("1", "them", "change the word to this")], [INC]);
    await runPoll(deps);
    deps.chat.fetchMessagesSince = async () => [];
    deps.now = () => "2026-07-18T12:00:00.000Z"; // >2h later
    await runPoll(deps);
    expect(deps.sent).toHaveLength(1);
    expect(JSON.stringify(deps.sent[0]).toLowerCase()).toContain("unclear");
  });
  it("advances the lastSeen cursor", async () => {
    const deps = makeDeps([m("1", "them", "hi", "2026-07-18T09:25:00.000Z")], [NOT]);
    await runPoll(deps);
    expect(await deps.store.getLastSeen("spaces/A")).toBe("2026-07-18T09:25:00.000Z");
  });
  it("logOnly suppresses sends but still records", async () => {
    const deps = makeDeps([m("1", "them", "isko dekh lena")], [TASK]);
    deps.logOnly = true;
    await runPoll(deps);
    expect(deps.sent).toHaveLength(0);
    expect(await deps.store.listByStatus("pending")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/poll.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/poll.ts`**

```ts
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

    // 1) try to resolve open incompletes with any new context
    const open = await store.listOpenIncomplete(spaceId);
    for (const d of open) {
      if (msgs.length > 0) {
        const merged = mergeIncomplete(d, msgs, await deps.classify({
          spaceId, trigger: msgs[msgs.length - 1],
          context: [...d.contextSnapshot, ...msgs], nowIst: deps.now(),
        }), deps.now());
        classified++;
        await store.saveDetection(merged);
        if (merged.status === "pending") await send(confirmationCard(merged));
      }
    }

    // 2) classify new messages from them
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

    // 3) advance cursor
    if (msgs.length > 0) {
      const newest = msgs.reduce((a, b) =>
        new Date(a.createTime) > new Date(b.createTime) ? a : b);
      await store.setLastSeen(spaceId, newest.createTime);
    }
  }

  // 4) expire stale incompletes (all spaces)
  for (const d of await store.listByStatus("incomplete")) {
    if (isExpired(d, deps.now())) {
      const flipped = { ...d, status: "pending" as const, updatedAt: deps.now() };
      await store.saveDetection(flipped);
      await send(confirmationCard(flipped, true));
    }
  }

  return { classified, pinged };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run`
Expected: all pass. If the "resolves open incomplete" test double-counts (the same new message also triggers a fresh classification in step 2), fix by marking messages consumed by an incomplete-merge as processed inside step 1 — the test suite defines the correct behavior: one card, one pending detection.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "add poll orchestrator"
```

---

### Task 12: Interact handler

**Files:**
- Create: `src/interact.ts`
- Test: `src/interact.test.ts`

**Interfaces:**
- Consumes: `Store`, `createTask` signature, card action names (`confirm_task` / `dismiss_task`) from Task 8
- Produces:
  - `interface InteractDeps { store: Store; createTask(d: Detection): Promise<void>; }`
  - `handleInteraction(event: any, deps: InteractDeps): Promise<object>` — parses a Chat `CARD_CLICKED` event, acts, and returns the response body Chat expects (an `actionResponse` of type `UPDATE_MESSAGE` replacing the card with a status line)

- [ ] **Step 1: Write failing test `src/interact.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { handleInteraction, type InteractDeps } from "./interact.js";
import { Store, makeFakeDb } from "./store.js";
import type { Detection } from "./types.js";

const d: Detection = {
  id: "spaces_A_messages_B", spaceId: "spaces/A", messageIds: ["spaces/A/messages/B"],
  contextSnapshot: [], verdict: "task", title: "Fix login error", dueDate: null,
  requester: "Rahul", status: "pending", sourceLink: "https://chat.google.com/room/A/B",
  createdAt: "2026-07-18T10:00:00Z", updatedAt: "2026-07-18T10:00:00Z",
};

function evt(fn: string, id = d.id) {
  return { type: "CARD_CLICKED",
    common: { invokedFunction: fn, parameters: { detectionId: id } } };
}

describe("handleInteraction", () => {
  let store: Store; let created: Detection[]; let deps: InteractDeps;
  beforeEach(async () => {
    store = new Store(makeFakeDb());
    await store.saveDetection(d);
    created = [];
    deps = { store, createTask: async (x) => { created.push(x); } };
  });

  it("confirm creates the task and marks confirmed", async () => {
    const res = await handleInteraction(evt("confirm_task"), deps);
    expect(created).toHaveLength(1);
    expect((await store.getDetection(d.id))?.status).toBe("confirmed");
    expect(JSON.stringify(res)).toContain("UPDATE_MESSAGE");
  });
  it("dismiss marks dismissed without creating", async () => {
    await handleInteraction(evt("dismiss_task"), deps);
    expect(created).toHaveLength(0);
    expect((await store.getDetection(d.id))?.status).toBe("dismissed");
  });
  it("is idempotent — second confirm does not create twice", async () => {
    await handleInteraction(evt("confirm_task"), deps);
    await handleInteraction(evt("confirm_task"), deps);
    expect(created).toHaveLength(1);
  });
  it("handles unknown detection gracefully", async () => {
    const res = await handleInteraction(evt("confirm_task", "nope"), deps);
    expect(JSON.stringify(res)).toContain("not found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/interact.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/interact.ts`**

```ts
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
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "add interact handler"
```

---

### Task 13: Digest handler

**Files:**
- Create: `src/digest.ts`
- Test: `src/digest.test.ts`

**Interfaces:**
- Consumes: `Store`, `digestMessage` from Task 8
- Produces:
  - `interface DigestDeps { store: Store; sendDm(body: object): Promise<void>; now(): string; }`
  - `runDigest(deps: DigestDeps): Promise<void>` — sends one DM: confirmed in the last 24h, all `pending`, all `incomplete` (as "unclear, never resolved")

- [ ] **Step 1: Write failing test `src/digest.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { runDigest } from "./digest.js";
import { Store, makeFakeDb } from "./store.js";
import type { Detection } from "./types.js";

function det(id: string, over: Partial<Detection>): Detection {
  return {
    id, spaceId: "spaces/A", messageIds: [id], contextSnapshot: [],
    verdict: "task", title: `title-${id}`, dueDate: null, requester: "R",
    status: "pending", sourceLink: "https://x", createdAt: "2026-07-17T10:00:00Z",
    updatedAt: "2026-07-17T12:00:00Z", ...over,
  };
}

describe("runDigest", () => {
  it("includes confirmed-yesterday, pending, and stale incompletes", async () => {
    const store = new Store(makeFakeDb());
    await store.saveDetection(det("c1", { status: "confirmed", updatedAt: "2026-07-17T15:00:00Z" }));
    await store.saveDetection(det("p1", { status: "pending" }));
    await store.saveDetection(det("i1", { status: "incomplete" }));
    await store.saveDetection(det("old", { status: "confirmed", updatedAt: "2026-07-10T09:00:00Z" }));
    const sent: object[] = [];
    await runDigest({ store, sendDm: async (b) => { sent.push(b); },
      now: () => "2026-07-18T03:30:00.000Z" });
    const s = JSON.stringify(sent[0]);
    expect(s).toContain("title-c1");
    expect(s).toContain("title-p1");
    expect(s).toContain("title-i1");
    expect(s).not.toContain("title-old");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/digest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/digest.ts`**

```ts
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
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "add digest handler"
```

---

### Task 14: Express app wiring and request auth

**Files:**
- Create: `src/index.ts`
- Test: `src/index.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `buildApp(overrides?)` returning an Express app (exported for tests), plus a main block that listens on `process.env.PORT ?? 8080`.
  - `POST /poll` and `POST /digest`: require header `x-api-secret` equal to `cfg.apiSecret`, else 401.
  - `POST /interact`: Google Chat sends a bearer JWT; verify with `OAuth2Client.verifyIdToken` (audience = `cfg.projectNumber`, issuer `chat@system.gserviceaccount.com`). In tests, verification is injected/faked.
  - `GET /healthz`: 200 "ok".

- [ ] **Step 1: Write failing test `src/index.test.ts`** (uses `fetch` against an ephemeral listener — no extra deps)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { buildApp } from "./index.js";

let server: Server; let base: string;
const calls: string[] = [];

beforeAll(async () => {
  const app = buildApp({
    apiSecret: "sekret",
    verifyChat: async () => true,
    poll: async () => { calls.push("poll"); return { classified: 0, pinged: 0 }; },
    digest: async () => { calls.push("digest"); },
    interact: async () => ({ ok: true }),
  });
  await new Promise<void>((r) => { server = app.listen(0, r); });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("app", () => {
  it("healthz is open", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
  it("rejects /poll without secret", async () => {
    expect((await fetch(`${base}/poll`, { method: "POST" })).status).toBe(401);
  });
  it("accepts /poll with secret", async () => {
    const res = await fetch(`${base}/poll`, {
      method: "POST", headers: { "x-api-secret": "sekret" } });
    expect(res.status).toBe(200);
    expect(calls).toContain("poll");
  });
  it("handles /interact", async () => {
    const res = await fetch(`${base}/interact`, {
      method: "POST", headers: { "content-type": "application/json",
        authorization: "Bearer fake" },
      body: JSON.stringify({ type: "CARD_CLICKED" }) });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/index.ts`**

```ts
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

// ---- main (skipped under vitest) ----
if (!process.env.VITEST) {
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
}
```

- [ ] **Step 4: Run tests + typecheck, verify pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "wire express app"
```

---

### Task 15: OAuth setup script + live smoke test

**Files:**
- Create: `scripts/auth-setup.ts`

**Interfaces:**
- Consumes: `Config`, `Store`
- Produces: a one-time local flow that stores `{ refreshToken }` in Firestore `auth/user`. Also the first live verification of chat reading.

- [ ] **Step 1: Write `scripts/auth-setup.ts`**

```ts
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
```

- [ ] **Step 2: GCP prerequisites (manual, gcloud)** — do these in the existing org project:

```bash
gcloud config set project <PROJECT_ID>
gcloud services enable chat.googleapis.com tasks.googleapis.com \
  firestore.googleapis.com aiplatform.googleapis.com run.googleapis.com \
  cloudscheduler.googleapis.com
gcloud firestore databases create --location=asia-south1
```

Then in the Cloud Console: **APIs & Services → OAuth consent screen** → User type **Internal** → add the two scopes. **Credentials → Create OAuth client ID → Web application** → authorized redirect URI `http://localhost:3000/callback`. Put client id/secret in `.env`.

- [ ] **Step 3: Run the auth flow**

Run: `npm run auth`, open the URL with the work account, approve.
Expected: "refresh token stored in firestore auth/user. done."

- [ ] **Step 4: Live smoke test of chat reading**

Temporarily run in a REPL-style script or `tsx -e`:
```bash
npx tsx -e "
import { loadConfig } from './src/config.js';
import { Store } from './src/store.js';
import { ChatClient } from './src/chat.js';
import { Firestore } from '@google-cloud/firestore';
const cfg = loadConfig();
const store = new Store(new Firestore({ projectId: cfg.projectId }));
const chat = await ChatClient.forUser(cfg, store);
const spaces = await chat.listDmSpaces();
console.log('dm spaces:', spaces.length);
const msgs = await chat.fetchMessagesSince(spaces[0], new Date(Date.now()-86400000).toISOString());
console.log(msgs.slice(-3));
"
```
Expected: your DM spaces count and the last 3 messages of one DM, with correct `sender: "me" | "them"` attribution. **If `me` detection is wrong** (numeric-id vs email mismatch — the wrinkle noted in Task 7), fix now: capture your numeric `users/<id>` from a message you sent, store it via `store.setAuthTokens`-style doc (`auth/user.userName`), and use it in `ChatClient.forUser`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "add oauth setup script"
```

---

### Task 16: Dockerfile, deployment, Chat app config, dry run

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docs/runbook.md`

**Interfaces:**
- Consumes: the whole service
- Produces: a live Cloud Run service, two Scheduler jobs, a configured Chat app, and a one-day log-only dry run.

- [ ] **Step 1: Create `Dockerfile` and `.dockerignore`**

`Dockerfile`:
```dockerfile
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
CMD ["node", "dist/src/index.js"]
```

`.dockerignore`:
```
node_modules
dist
.env
samples
docs
.git
```

- [ ] **Step 2: Deploy to Cloud Run**

```bash
gcloud run deploy tasklens \
  --source . --region asia-south1 --no-allow-unauthenticated=false \
  --allow-unauthenticated \
  --set-env-vars GCP_PROJECT_ID=<ID>,GCP_PROJECT_NUMBER=<NUM>,GEMINI_MODEL=gemini-2.5-flash,USER_EMAIL=shaqeeb.akhtar@wisdmlabs.com,LOG_ONLY=true \
  --set-env-vars GEMINI_API_KEY=<KEY>,OAUTH_CLIENT_ID=<CID>,OAUTH_CLIENT_SECRET=<CSECRET>,API_SECRET=<RANDOM_32_CHARS>
```
(Endpoints are self-guarded: `/poll`+`/digest` by `x-api-secret`, `/interact` by Chat JWT — public URL is acceptable for v1.)
Expected: a service URL like `https://tasklens-xxxxx.asia-south1.run.app`; `GET /healthz` returns ok.

- [ ] **Step 3: Create Scheduler jobs**

```bash
gcloud scheduler jobs create http tasklens-poll \
  --location asia-south1 --schedule "*/15 9-19 * * 1-5" \
  --time-zone "Asia/Kolkata" --http-method POST \
  --uri "https://<SERVICE_URL>/poll" \
  --headers "x-api-secret=<API_SECRET>"

gcloud scheduler jobs create http tasklens-digest \
  --location asia-south1 --schedule "0 9 * * 1-5" \
  --time-zone "Asia/Kolkata" --http-method POST \
  --uri "https://<SERVICE_URL>/digest" \
  --headers "x-api-secret=<API_SECRET>"
```

- [ ] **Step 4: Configure the Chat app**

Cloud Console → **Google Chat API → Configuration**: app name "TaskLens", avatar URL (any), description, **Interactive features ON**, connection type **HTTP endpoint** = `https://<SERVICE_URL>/interact`, visibility: **only yourself**. Then in Google Chat, find the TaskLens app and send it "hi" once (this creates the app↔user DM that `findDirectMessage` needs).

- [ ] **Step 5: Dry run (LOG_ONLY), then go live**

Day 1: leave `LOG_ONLY=true`. Trigger manually once:
```bash
curl -X POST -H "x-api-secret: <API_SECRET>" https://<SERVICE_URL>/poll
```
Read Cloud Run logs (`gcloud run services logs read tasklens --region asia-south1`): verify detections look sane against real chats for a working day. Then flip live:
```bash
gcloud run services update tasklens --region asia-south1 --update-env-vars LOG_ONLY=false
```
Expected: next real task message produces a confirmation card in your TaskLens DM; ✅ creates a Google Task visible in Gmail's Tasks sidebar.

- [ ] **Step 6: Write `docs/runbook.md`** — one page: env vars table, the three curl commands (poll/digest/healthz), how to re-run `npm run auth` if tokens break, how to view logs, how to pause (pause the Scheduler jobs).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "add dockerfile and deployment runbook"
```

---

## Self-Review (completed)

- **Spec coverage:** polling window/cron (T16), context assembly incl. quotes + own messages (T3/T7), Hinglish classifier with bias rule (T4), validation-first gate (T5), incomplete lifecycle + 2h unclear ping (T9/T11), confirmation cards (T8/T12), Google Tasks with source link (T10), digest safety net (T13), Firestore state + dedupe (T6), log-only dry run (T2/T11/T16), error handling via cursor-resume + processed dedupe (T6/T11). No gaps found.
- **Placeholder scan:** no TBDs; the Task 7 sender-id wrinkle is deliberately documented with its resolution path and verified in Task 15 Step 4.
- **Type consistency:** `Store.docId`, `PollDeps`, card action names `confirm_task`/`dismiss_task`, and `Detection` fields cross-checked across Tasks 6–13.
