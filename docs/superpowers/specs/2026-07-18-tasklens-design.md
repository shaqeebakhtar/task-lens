# TaskLens — Design Spec

**Date:** 2026-07-18
**Status:** Approved pending user review
**Owner:** Shaqeeb Akhtar

## Problem

Work tasks at WisdmLabs are assigned informally through Google Chat DMs — often in Hinglish, often small, sometimes quoting older messages, and sometimes incomplete ("change the word to this") until a clarifying back-and-forth resolves them. There is no board or tracker. Result: tasks get forgotten, and completed tasks leave no record.

## Solution

TaskLens is a personal service that watches the user's Google Chat DMs during working hours, uses Gemini Flash to detect task-like messages (English and Hinglish) with full conversational context, and — after a one-tap confirmation — creates them in Google Tasks with a link back to the original message. No detection is ever silently lost.

## Key decisions (agreed during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Chat access | Internal OAuth app under wisdmlabs.com org (verified: user can create GCP projects in the org) | No Google verification, no 7-day token expiry, no admin conversation |
| Sources watched | DMs only | That's where tasks arrive; group spaces out of scope for v1 |
| Task backend | Google Tasks | Same ecosystem/OAuth app; due dates surface in Gmail + Calendar; mobile app exists |
| Detection flow | Confirm before creating (Chat card with ✅/❌), with persistence so ignored pings never vanish | User preference; clean task list |
| Hosting | GCP free tier: Cloud Run + Cloud Scheduler + Firestore, in the same project | Always on, effectively free, one ecosystem |
| LLM | Gemini Flash via the organization's Gemini account | Free/cheap, handles Hinglish, and chat content stays within the org's Google account — mitigates the data-privacy concern of third-party LLM APIs |
| Polling window | Every 15 minutes, 9:00–20:00 IST, Mon–Fri | User's working hours; first poll of the day catches overnight backlog |

## Architecture

```
Cloud Scheduler  (*/15 9-19 * * 1-5, Asia/Kolkata)
      │ triggers
      ▼
Cloud Run service (single service, two endpoints)
  ├── /poll  ──► Chat API: fetch new DM messages since last-seen per space
  │               │  (resolve quoted messages; include rolling context window)
  │               ▼
  │             Gemini Flash classifier ──► not_task | task | task_incomplete
  │               │
  │               ├─ not_task ──────► mark seen
  │               ├─ task ──────────► save pending → send confirmation card
  │               └─ task_incomplete ► hold open; merge new messages on later
  │                                    polls until complete or 2h timeout
  │
  └── /interact ◄── Chat app button clicks (✅ / ❌)
        ├─ ✅ ──► create Google Task (title, due date, notes: requester +
        │          deep link to source message) → mark confirmed
        └─ ❌ ──► mark dismissed (kept for prompt tuning)

Daily 9:00 digest (Scheduler → /digest): tasks created yesterday +
anything still pending/unconfirmed — the safety net.
```

## Components

### 1. Poller (`/poll`)
- Lists the user's DM spaces via the Chat API (`chat.messages.readonly`, user OAuth credentials).
- Fetches messages newer than the per-space `lastSeen` timestamp stored in Firestore.
- Downtime and off-hours are harmless: polling resumes from `lastSeen`, so nothing is missed — overnight messages are processed at the first 9:00 poll.
- The user's own messages are never task **triggers**, but they **are** included in context (their clarifying questions like "what and where?" matter).

### 2. Context assembly (core requirement, not an implementation detail)
The classifier never sees a message in isolation. Every classification input contains:
1. **The quoted message**, resolved via the Chat API — "isko dekh lena" is meaningless without the "isko."
2. **A rolling window of recent messages** from the same DM (last 5 messages or 30 minutes, whichever is larger) — tasks are often split across messages ("bhai ek kaam tha" → "woh login page pe error aa raha" → "dekh lena jab free ho").
3. **Sender attribution** per message, distinguishing the other person from the user.

The extracted task title must come from the **combined context**, not the trigger message ("Fix error on login page", not "dekh lena").

### 3. Classifier (Gemini Flash)
- One call per candidate message, returning structured JSON:
  `{ verdict: "not_task" | "task" | "task_incomplete", title, due_date, requester, confidence, reasoning }`
- Prompt includes real Hinglish few-shot examples ("isko dekh lena", "kal tak chahiye", "jab free ho tab kar dena") and relative-date rules ("kal tak" → tomorrow's date, computed from poll time in IST).
- **Bias rule:** when unsure, lean toward `task`. A false positive costs one ❌ tap; a false negative recreates the original problem.

### 4. Incomplete-task lifecycle
- `task_incomplete` detections are **held open** in Firestore instead of pinging immediately.
- On subsequent polls, new messages in the same DM are merged into the open detection and re-classified with the accumulated context.
- When classification flips to `task` (details resolved), the user gets **one** confirmation card with the complete task.
- If still incomplete after **2 hours**, it pings anyway as "possible task, details unclear" — clarified verbally or not, it never vanishes.

### 5. Confirmation bot (Chat app, `/interact`)
- A Google Chat app in the same GCP project (Internal), able to DM the user.
- Sends interactive cards: task title, due date, requester, source link, ✅ **Create task** / ❌ **Not a task** buttons.
- Button clicks POST to `/interact` on the Cloud Run service.
- Unactioned cards remain `pending` and are re-surfaced in the digest.

### 6. Task creator
- On ✅: creates a Google Task via the Tasks API (`tasks` scope) with title, due date, and notes containing the requester's name and a deep link to the source Chat message.
- Due dates appear on Google Calendar automatically.

### 7. Morning digest (`/digest`, 9:00 IST)
DMs the user a summary: tasks created yesterday, pending confirmations never actioned, and incomplete detections that never resolved. Nothing silently disappears — this is the backstop for every other component.

## State (Firestore, free tier)

| Collection | Purpose | Key fields |
|---|---|---|
| `spaces` | Poll cursor per DM | spaceId, lastSeen |
| `detections` | Every detection and its lifecycle | messageId(s), context snapshot, verdict, title, dueDate, status: `incomplete` → `pending` → `confirmed` / `dismissed` / `expired`, timestamps |
| `processed` | Dedupe guard | messageId — restarts and retries never double-create |

## Error handling

- **Poll or service failure:** next poll resumes from `lastSeen`; at-least-once processing with `processed` dedupe means no loss and no duplicates.
- **Gemini call failure:** message stays unprocessed and retries next poll.
- **OAuth token refresh failure:** the bot DMs the user a re-auth link (Internal apps make this rare).
- **Unknown card interaction / stale card:** respond gracefully, log, never crash the service.

## Testing

The classifier is the highest-risk component and gets validated **first, before any infrastructure work**:
1. Collect ~30 real messages from chat history — a mix of clear tasks, non-tasks, Hinglish, quoted-message tasks, and multi-message incomplete tasks.
2. Run them through the classifier prompt as a local script; measure misses and false positives.
3. Tune the prompt until it catches **all** real tasks with an acceptable false-positive rate.

Then: unit tests for context assembly (quote resolution, rolling window, sender attribution) and the incomplete-merge logic; an end-to-end dry run against live chats in "log only" mode (no cards sent) for a day before enabling confirmations.

## Out of scope (v1)

Group spaces, any task board/UI, marking tasks done from chat, tracking tasks assigned **to others**, auto-completing tasks when someone replies "done hai", multi-user support. All possible later; none needed to solve the core problem.
