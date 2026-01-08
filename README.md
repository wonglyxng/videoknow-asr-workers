# VideoKnow ASR Worker (OpenAI-Compatible) - Whisper Large v3 Turbo + R2

This Cloudflare Worker exposes an **OpenAI API compatible** speech-to-text endpoint:

- Endpoint: `POST /v1/audio/transcriptions`
- Model: `@cf/openai/whisper-large-v3-turbo`
- Audio input options:
  1) **Standard OpenAI style**: upload a `file` via `multipart/form-data`
  2) **Extension (recommended)**: provide `r2_key` (R2 object key). The Worker fetches the audio from your R2 bucket and transcribes it.

It also supports `response_format=verbose_json` and returns an output aligned to OpenAI’s typical `verbose_json` shape (including `language/duration/segments/words/usage/text`).

---

## Project structure

````

.
├── wrangler.jsonc
└── src
└── index.ts

````

---

## Prerequisites

- A Cloudflare account with **Workers**, **R2**, and **Workers AI** enabled
- Node.js installed locally
- Wrangler (Cloudflare’s CLI)

---

## 1. Configure `wrangler.jsonc`

> ⚠️ R2 bucket names **cannot** contain underscores `_`. They must use lowercase letters, digits, and hyphens `-`.
> Set `bucket_name` to the **existing** valid bucket name from your Cloudflare dashboard.

Example:

```jsonc
{
  "name": "videoknow-asr",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-01",
  "compatibility_flags": ["nodejs_compat"],

  "ai": { "binding": "AI" },

  "r2_buckets": [
    { "binding": "BUCKET_DEV", "bucket_name": "bucket-dev" }
  ]
}
````

---

## 2. Login to Cloudflare

From the project root:

```bash
npx wrangler login
```

---

## 3. Create / verify the R2 bucket

### 3.1 List buckets

```bash
npx wrangler r2 bucket list
```

### 3.2 Create the bucket (if needed)

```bash
npx wrangler r2 bucket create bucket-dev
```

### 3.3 Upload a test audio file (optional)

```bash
npx wrangler r2 object put bucket-dev/uploads/audio/test.mp3 --file ./test.mp3
```

---

## 4. Set the auth secret (AUTH_KEY)

This Worker uses `Authorization: Bearer <AUTH_KEY>` for authentication.

Set the secret:

```bash
npx wrangler secret put AUTH_KEY
```

### One-liner to generate a random AUTH_KEY (optional)

**Windows (PowerShell)**

```powershell
$k = [Convert]::ToBase64String((1..32 | ForEach-Object {Get-Random -Minimum 0 -Maximum 256}))
$k | npx wrangler secret put AUTH_KEY
```

**macOS / Linux**

```bash
openssl rand -base64 32 | npx wrangler secret put AUTH_KEY
```

---

## 5. Run locally (optional)

```bash
npx wrangler dev
```

---

## 6. Deploy

```bash
npx wrangler deploy
```

Wrangler will print your Worker URL, typically like:

`https://videoknow-asr.<your-subdomain>.workers.dev`

---

## 7. API usage

### 7.1 Health check

```bash
curl "https://<your-worker-domain>/health"
```

### 7.2 Standard OpenAI style: upload a file

```bash
curl "https://<your-worker-domain>/v1/audio/transcriptions" \
  -H "Authorization: Bearer <AUTH_KEY>" \
  -H "Content-Type: multipart/form-data" \
  -F file="@./test.mp3" \
  -F model="whisper-1" \
  -F response_format="json"
```

### 7.3 Recommended: use `r2_key` (no upload)

```bash
curl "https://<your-worker-domain>/v1/audio/transcriptions" \
  -H "Authorization: Bearer <AUTH_KEY>" \
  -H "Content-Type: multipart/form-data" \
  -F r2_key="uploads/audio/test.mp3" \
  -F model="whisper-1" \
  -F response_format="verbose_json" \
  -F "timestamp_granularities[]=segment" \
  -F "timestamp_granularities[]=word"
```

---

## 8. Supported `response_format`

* `json` (default): `{ "text": "..." }`
* `text`: plain text
* `vtt`: WebVTT subtitles (requires model VTT output)
* `srt`: SRT subtitles (converted from VTT)
* `verbose_json`: richer structure:

  * `task, language, duration, text, segments, (optional) words, usage`

### timestamp_granularities[]

Allowed **only** when `response_format=verbose_json`:

* `timestamp_granularities[]=segment` (default)
* `timestamp_granularities[]=word` (adds top-level `words`, flattened from segment words)

---

## 9. Logs & troubleshooting

Tail live logs:

```bash
npx wrangler tail
```

Common issues:

1. **bucket_name validation error (contains `_`)**

   * Rename/use a valid bucket name like `bucket-dev`, and make sure it exists in the dashboard.

2. **401 Invalid API key**

   * Verify request header: `Authorization: Bearer <AUTH_KEY>`
   * Ensure you ran: `npx wrangler secret put AUTH_KEY`

3. **R2 object not found**

   * `r2_key` must exactly match the object key in R2 (case-sensitive)

---

## License
MIT
