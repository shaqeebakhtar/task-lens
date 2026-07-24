# TaskLens Runbook

Operational reference for the TaskLens Cloud Run service. See
`docs/implementation-plan.md` Task 16 for the full first-time
deploy walkthrough; this page is the day-to-day cheat sheet.

## Environment variables

| Var | Required | Notes |
|-----|----------|-------|
| `GCP_PROJECT_ID` | yes | Firestore + Cloud Run project id |
| `GCP_PROJECT_NUMBER` | yes | Audience for the Chat JWT verification on `/interact` |
| `GEMINI_API_KEY` | yes | Gemini API key for the classifier |
| `GEMINI_MODEL` | no | Defaults to `gemini-2.5-flash` |
| `OAUTH_CLIENT_ID` | yes | OAuth web client id (chat read + tasks) |
| `OAUTH_CLIENT_SECRET` | yes | OAuth web client secret |
| `API_SECRET` | yes | Shared secret for `/poll` and `/digest` (`x-api-secret` header) |
| `USER_EMAIL` | yes | The work account whose DMs are polled |
| `LOG_ONLY` | no | `true` = full pipeline runs but no cards sent / no tasks created |
| `PORT` | no | Defaults to `8080` (Cloud Run injects this) |

## Endpoints

```bash
# health (open, no auth)
curl https://<SERVICE_URL>/healthz

# trigger a poll manually (Scheduler normally does this every 15 min, work hours)
curl -X POST -H "x-api-secret: <API_SECRET>" https://<SERVICE_URL>/poll

# trigger the daily digest manually (Scheduler normally does this at 09:00 IST)
curl -X POST -H "x-api-secret: <API_SECRET>" https://<SERVICE_URL>/digest
```

`/interact` is called by Google Chat itself (button clicks) and is authenticated
with a Chat-issued bearer JWT — not called by hand.

## Scheduling

- Poll cron: `*/15 9-19 * * 1-5`, time zone `Asia/Kolkata`.
- Digest cron: `0 9 * * 1-5`, time zone `Asia/Kolkata`.

## Common operations

**View logs**
```bash
gcloud run services logs read tasklens --region asia-south1
```

**Re-authorize (refresh token broke / revoked)**
```bash
npm run auth   # opens the OAuth URL; approve with the WORK account
```
This rewrites `auth/user` in Firestore with a fresh refresh token.

**Toggle live vs dry-run**
```bash
# go dry-run (no cards, no tasks)
gcloud run services update tasklens --region asia-south1 --update-env-vars LOG_ONLY=true
# go live
gcloud run services update tasklens --region asia-south1 --update-env-vars LOG_ONLY=false
```

**Pause / resume the service** (stop it acting without deleting anything)
```bash
gcloud scheduler jobs pause  tasklens-poll   --location asia-south1
gcloud scheduler jobs pause  tasklens-digest --location asia-south1
# resume
gcloud scheduler jobs resume tasklens-poll   --location asia-south1
gcloud scheduler jobs resume tasklens-digest --location asia-south1
```

## Firestore collections

- `spaces/{spaceId}` — poll cursor (`lastSeen`) per DM.
- `processed/{messageId}` — dedupe of classified messages.
- `detections/{id}` — detection lifecycle (`incomplete` → `pending` → `confirmed`/`dismissed`).
- `auth/user` — the OAuth refresh token.

Note: `listConfirmedSince` uses a composite filter (`status` + `updatedAt`).
The first time the digest runs, Firestore logs a link to auto-create the
required composite index — follow that link once.
