# Images in prompts — 2026-10-29

**Status:** shipped in v0.7.8 (`@onagent/bridge` 0.3.0 not yet published to npm),
released before the review fixes below.
Unit and integration tests pass, apart from the
`TestRegistryBackendDispatch_UpdateClearsDispatchWhenOmitted` failure, which
also fails on a clean v0.7.7. Not yet run against a real model. A code review
raised the items under [Review findings](#review-findings-2026-10-29). Items
R1, R2 and R5 remain open and should be fixed next.

## Why

want v0.5.0 accepts images in user messages (`Orchestrator.SubmitContent`)
and can keep their bytes outside the conversation history
(`types.BlobStore`). This change exposes that to end users of an app through
the SDK, and gives app owners control over it.

## Decisions

Decided with the user before implementation:

| Question | Decision | Rejected alternative |
|---|---|---|
| How images reach the backend | Inline base64 in the `prompt` envelope, over WS and SSE alike | A separate upload endpoint that returns a ref. Smaller messages, but adds a new endpoint, its own authorization, and cleanup of uploads that are never used |
| Where image bytes live | New Postgres table `agent_blobs`; history keeps only a `sha256:` ref | GCS, which needs a bucket, IAM, and a new dependency, and complicates local development and the public Docker image. Base64 in `agent_experiences` JSONB, which makes the table grow fast and slows every per-turn Load |
| Which apps accept images | Opt-in per app, off by default | Every app on, bounded by platform caps only. Images cost far more tokens than text and bill to the owner |
| Scope | End-user prompts only | Images in bridge tool results as well (want supports it; the protocol and SDK don't yet) |

## What was built

### Protocol (`backend/internal/protocol/message.go`, `packages/bridge/src/protocol.ts`)

- `PromptPayload.images?: [{ mediaType, data }]`: base64 without a `data:`
  prefix; png, jpeg, gif or webp. The field is omitted for text-only
  prompts, so older SDKs are unaffected.
- New error codes, which reject only that one prompt, the same way
  `prompt_too_long` does: `images_not_allowed`, `too_many_images` and
  `invalid_image`.

### Per-app setting

- `apps.max_prompt_images INTEGER`. NULL means images are off.
  `toolschema.App.MaxPromptImages` and `Registry.SetMaxPromptImages`
  (`internal/toolschema/registry.go:399`) reject values of zero or less.
  Clearing the setting is how to turn images off.
- `inference.EffectiveMaxPromptImages` returns 0 when the app setting is nil.
  Otherwise it returns the app's value, clamped to `MAX_PROMPT_IMAGES`
  (default 4).
- Ways to set it:
  - API: `PUT /console/apps/{appId}/max-prompt-images`
  - CLI: `onagent app maxpromptimages set <appId> <n|clear>`; `app get`
    prints the value
  - Console: an "Images per prompt" setting (desktop form, plus a mobile row
    and `MaxPromptImagesEditSheet`)
- App summaries return `maxPromptImages` and `systemMaxPromptImages`.

### Validation and size (`backend/internal/ws/session.go`)

- `checkPromptImages` (`:436`) runs in `handlePrompt` (`:394`) after the
  quota and length gates, and before inference. It runs these checks in
  order:
  1. app allows images
  2. count is within the limit
  3. each image passes want's `types.ValidateImageSource` (`:455`), which
     checks media type, real base64, content sniffed to match the declared
     type, and 5 MiB decoded
- `inboundLimit` (`:207`) is 1 MiB, plus space for the base64 of as many
  5 MiB images as the app allows. It is applied:
  - per WS read, before each `ReadMessage` (`:187`)
  - per SSE POST (`sse.go:266`)

  Before hello, and for apps without images, the limit is exactly 1 MiB. At
  the default of 4 images it is about 29 MB, under Cloud Run's 32 MiB HTTP
  request limit.

### Inference and storage

- `inference.Request.Images`. `WantService` calls `submitPrompt`
  (`internal/inference/want.go:404`):
  - text-only prompts use the unchanged `Submit` path
  - otherwise it calls `SubmitContent`, with the images first and the text
    after them
- `sessionstore.Store.BlobsForApp` (`internal/sessionstore/blobs.go`) is a
  `types.BlobStore` scoped to one app over `agent_blobs`:
  - primary key `(app_id, hash)`
  - `Put` is insert-or-ignore
  - `Get` returns `types.ErrBlobNotFound` for a ref that belongs to another
    app
  - It is injected next to `ForApp` in `buildOrchestrator`
    (`want.go:176`).
- Quota is unchanged. Usage is recorded from the token counts the provider
  reports, so image tokens are counted automatically.

### SDK (`packages/bridge`, 0.3.0)

- `prompt(text, { images })`
- `imageFromBlob(file)`, which rejects unsupported types and encodes in
  chunks
- `ErrorCode` entries for the new codes, plus `PromptTooLong`, which was
  missing

## Review findings (2026-10-29)

Each item lists the reviewer's scenario and my assessment.

### R1 — Image policy is fixed at hello, so turning images off doesn't reach open sessions 🟠 (fix before release)

**Where:** `session.go:209` (`inboundLimit`) and `:338` (`handlePrompt`):
both read `s.app`, the `*toolschema.App` snapshot taken at hello.

**Scenario:** an owner sees image costs rising and clears
`maxPromptImages`. Every session opened before that keeps accepting up to the
old count until the visitor disconnects, and the owner keeps paying. That
contradicts the schema and CHANGELOG, which say clearing the setting rejects
images.

**Assessment:** valid. `MaxPromptLength` has always behaved this way, as
does the `enabled` switch, which explicitly leaves open connections alone.
Images carry real cost, though, so the gap matters here.

**Fix:** in `checkPromptImages` and `inboundLimit`, read the current app
from the Registry (`s.apps.Get(app.AppID)`, an in-memory map read) instead
of the hello snapshot.

### R2 — A prompt over the size limit drops the connection instead of returning a coded error 🟠 (fix before release)

**Where:** `session.go:187` (WS read limit) and `sse.go:266` (SSE body
limit).

**Scenario:** an app allows 1 image, so its limit is about 7.7 MB. A user
attaches two 4 MB photos, about 10.7 MB of base64.
- **WS:** gorilla's `ReadMessage` fails and the socket closes (1009). The
  bridge reconnects and the prompt is silently lost.
- **SSE:** the POST gets 413. The SDK treats that as rejected and doesn't
  resend, but no `error` envelope ever reaches the page.

So `too_many_images` and `invalid_image` mostly never get sent for realistic
photo sizes.

**Assessment:** valid. This is the most visible problem for end users.

**Fix:** both parts below.
1. **The SDK checks before sending.** The ack also returns the app's
   effective `maxPromptImages` (`AckPayload`, `protocol/message.go:72`). The
   SDK rejects locally, through `onError` with the same codes, when:
   - images are off
   - there are too many images
   - an image is over 5 MiB
2. **Server limit based on the system cap.** `inboundLimit` for any app with
   images on uses the system-wide `MAX_PROMPT_IMAGES` instead of the app's
   own count, so a prompt with a few too many images still arrives and gets
   `too_many_images`. Apps without images stay at 1 MiB.

### R3 — Our 5 MiB check is on decoded bytes; Anthropic's 5 MB limit may be on base64 ⚪ (want-side, later)

**Where:** `session.go:455` uses want's `types.MaxImageBytes`.

**Scenario:** with the Claude provider, a 4.5 MiB JPEG passes our check, but
its base64 (about 6 MB) is rejected by Anthropic. The user gets a generic
`want submit failed`. If want already persisted the user turn, every later
prompt in that session replays the image and fails too.

**Assessment:** plausible. I didn't confirm whether Anthropic measures the
encoded or the decoded size. Production uses Gemini, which allows 20 MB
inline per request, so production isn't affected.

**Fix:** belongs in want: make the per-image ceiling provider-aware, or
define it on the encoded size. Revisit if a Claude deployment is planned.

### R4 — The larger limit applies to every message type, and each large message is copied several times in memory 🟡 (monitor)

**Where:** `session.go:207` (`inboundLimit`). It also covers `hello` and
`tool_result`. A large message is held in memory several times:
- as raw bytes
- as unmarshalled strings
- as the decoded buffers from validation

**Scenario:** on an image-enabled app, a few dozen concurrent sessions each
send about 29 MB at once. Each costs roughly 80 MB at peak, enough to run a
Cloud Run instance out of memory.

**Assessment:** valid, but it is limited to apps that turned images on, and
a connection still needs the API key and an allowed origin. On WS the
message type isn't known until the whole frame has been read, so a full fix
means stream-decoding.

**Possible steps, in order of cost:**
- On SSE, raise the limit only when the body is a prompt (peek at `type`).
- Pass the decoded bytes on instead of decoding twice (see R6).
- Set a per-instance memory budget, or a concurrency cap on large messages.

### R5 — Console input's `max` attribute blocks saving values over the system cap 🟡 (fix before release)

**Where:** `apps/console/src/AppSettingsView.tsx:187` and
`MaxPromptImagesEditSheet.tsx:51`.

**Scenario:** `MAX_PROMPT_IMAGES` is lowered from 8 to 4 while an app has 6
stored. The draft shows 6, and pressing Save triggers the browser's own
"must be ≤ 4" bubble, so `saveMaxPromptImages` never runs. The App.tsx
comment says values over the cap are accepted and clamped, not blocked.

**Fix:** remove `max`. The hint already states the cap.

### R6 — Each image is decoded and validated twice ⚪

**Where:** `checkPromptImages` validates the image, and then want's
`SubmitContent` and `BlobStore.Put` decode it again.

**Assessment:** true; it's performance only. A 4-image prompt decodes about
20 MB twice. It goes away if the session passes along the decoded bytes, or
relies on `SubmitContent`'s own validation with its error mapped to
`invalid_image`. Worth doing together with R4.

### R7 — Images are re-read and re-sent on every later turn ⚪ (known limit)

**Where:** want's `Load` restores every ref in the session's history on
every prompt (`blobs.go` `Get`).

**Scenario:** a session attaches 4 × 5 MB on turn 1, then sends 20
text-only follow-ups. That is about 400 MB of BYTEA reads, and the image
tokens are billed about 20 times.

**Assessment:** already listed as a known limit in the CHANGELOG.

**Fix:** belongs in want: a retention option such as "only the last N
turns keep images; older ones become a text placeholder". want's
`rehydrate` already has the placeholder path.

### R8 — Deleting an app leaves its images behind ⚪

**Where:** `internal/db/schema.sql:452`. `agent_blobs` has no FK, and
`deleteApp` (`internal/console/console.go:1040`) doesn't remove its rows.

**Assessment:**
- **Storage leak:** valid. `agent_experiences` has the same gap, by design
  ("history should outlive the app"), so the two need one retention policy
  together.
- **A recreated app with the same ID inheriting the images:** low risk. To
  read an old image, the new app's history would have to already contain
  its exact ref.

### R9 — The mobile row shows the unsaved draft ⚪

**Where:** `apps/console/src/AppSettingsList.tsx:133`.

**Scenario:** an owner types 3, closes the sheet without saving, and the row
reads "Up to 3" while the backend is still off.

**Assessment:** the existing "Max prompt length" row does the same.

**Fix:** if fixed, fix both rows together: render from `activeSummary`, or
reset the draft when the sheet closes.

### R10 — The CLI accepts 0 or a negative value and only fails at the server ⚪

**Where:** `backend/cmd/onagent/main.go:780`.

**Assessment:** `maxpromptlength set` behaves the same way.

**Fix:** a local `n <= 0` check that suggests `clear` would fix both
commands.

## Deferred (not part of this change)

- Image input in the console Playground.
- Images in bridge tool results: want supports this, but the protocol's
  `tool_result` and the SDK's handler return value need an image block.
- A retention policy for `agent_blobs` together with `agent_experiences`
  (R8), and per-turn image retention in want (R7).

## Testing

- **Unit tests:**
  - `internal/inference/max_prompt_images_test.go`
  - `internal/ws/session_prompt_images_test.go`, covering every rejection
    code, ordering, a text-only prompt on an app without images, and
    `inboundLimit`
  - `packages/bridge/src/client.images.test.ts`
- **Integration tests (Postgres):**
  - `internal/sessionstore/blobs_integration_test.go`, covering the round
    trip, dedup, per-app scope, malformed refs, and history storing a ref
    that comes back as base64 through want
  - `internal/toolschema` `TestSetMaxPromptImages`
  - `internal/ws/sse_images_integration_test.go`, where a POST over 1 MiB
    gets 413 until the app opts in, then reaches inference
  - The admin schema-check table list now includes `agent_blobs`.
- **Not yet done:** an end-to-end run against a real model (Gemini) from a
  browser.
