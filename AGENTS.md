# AGENTS.md

## Architecture

- **Single-file Cloudflare Worker**: entire app in `index.js` (HTML template + CSS + client JS + Worker fetch handler)
- No build step, no bundler, no dependencies — deploy directly with `wrangler`
- TTS: Microsoft Edge TTS via `dev.microsofttranslator.com` endpoint
- STT: SiliconFlow API (`FunAudioLLM/SenseVoiceSmall` model)

## Commands

```bash
wrangler deploy          # Deploy to Cloudflare Workers
wrangler dev             # Local development server
```

## Key Files

- `index.js` — entire application (frontend + backend)
- `wrangler.toml` — Cloudflare Workers config (name: tts-voice-magic)

## API Endpoints

- `GET /` — serves HTML page
- `POST /v1/audio/speech` — TTS (JSON body or multipart/form-data for file upload)
- `POST /v1/audio/transcriptions` — STT (multipart/form-data)

## Gotchas

- **Token refresh**: Microsoft TTS token cached in memory, auto-refreshes 3 min before expiry
- **Long text**: auto-splits into chunks (max 1500 chars), processes in batches of 3 with 800ms delay
- **Chunk limit**: max 40 chunks per request (Cloudflare subrequest limit)
- **SSML mode**: bypasses voice/speed/pitch/style controls
- **Frontend i18n**: 8 languages, detects browser language, persists to localStorage
