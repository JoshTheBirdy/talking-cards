# Voice server protocol

Obsidian's Android app runs plugins in a WebView with no `speechSynthesis`, and plugins can't
call Android's `TextToSpeech`. A companion app can: it runs a small HTTP server on the phone,
and Talking Cards asks it to speak. Any app that implements this works. The reference
implementation is the Reader app's voice server.

## Transport

- HTTP on `127.0.0.1`. The default port is **51515**, and the user can change it in settings.
- The server must listen only on the loopback interface.
- Every request carries `X-Reader-Token: <token>`.
  - The app generates the token and shows it so the user can copy it into Talking Cards.
  - A missing or wrong token gets `401`.
- The plugin calls through Obsidian's `requestUrl`, so CORS doesn't apply. Servers may still send
  `Access-Control-Allow-*` headers for browser clients.
- Errors are JSON, `{"error": "message"}`, with a 4xx/5xx status.

## Endpoints

### `GET /status`

```json
{ "app": "Reader", "version": "0.5.1", "voices": 32 }
```

### `GET /voices`

```json
{
  "voices": [
    { "id": "system:en-gb-x-gba-local", "name": "English (UK) — Google", "lang": "en-GB", "kind": "system", "default": true }
  ]
}
```

- `id` is opaque to the plugin and is sent back as-is to `/synthesize`.
- `kind` is `"system"` (an Android `TextToSpeech` voice) or `"neural"` (the app's own voices).
- `default: true` marks the phone's default voice; the plugin uses it for "Automatic".

### `POST /synthesize`

```json
{ "text": "What is the powerhouse of the cell?", "voice": "system:en-gb-x-gba-local", "speed": 1.0 }
```

- `voice` may be `null`, meaning the default voice.
- `speed` is a multiplier: 1.0 is normal speed.
- The response is `200`, `Content-Type: audio/wav`, as PCM WAV:
  - 8/16/24/32-bit integer or 32-bit float samples,
  - any sample rate,
  - mono preferred (extra channels are averaged).
- The plugin plays the audio itself, so the server only renders it. On Android that is
  `TextToSpeech.synthesizeToFile`.

## Notes for implementers

- Run the server in a foreground service, so it survives Obsidian being in front.
- Don't block the main thread: `TextToSpeech` initialisation needs it.
- Synthesis requests arrive one at a time, and the plugin prefetches the next card's audio while
  the current one plays. 1–2 s per sentence is fine.
