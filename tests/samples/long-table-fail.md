Locked in. Finalized plan below.

---

# Plan: Extract `web/ui/asr` analog → `sdk/node_sdk` (Phase 1: ASR only)

## Locked decisions
- **Migrate**: code physically moves out of `web/ui/asr`; UI consumes `sdk/node_sdk` as a `file:` dependency.
- **WebSocket abstraction**: `createWebSocket()` dialect — `ws` in Node, native global in browser, factory injectable for tests.
- **Scope = ASR only**: transcribe + translate channels, PCM utils, `buildUrl`, VAD presets. TTS / WAV I/O / CLI / playback deferred.
- **API = Async + callbacks**: Promise-based `connect()`/`streamBytes()`, plus `onResult()`/`onSkipped()`/… event subscriptions.

---

## 1. New package: `sdk/node_sdk/`

### 1.1 `package.json`
```jsonc
{
  "name": "alt_gateway",        // mirror python_sdk
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },   // ship TS source (no build step in Phase 1)
  "engines": { "node": ">=20" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test:unit": "vitest run",
    "test": "vitest run"
  },
  "dependencies": { "ws": "^8.18.0" },
  "devDependencies": {
    "@types/node": "^20", "@types/ws": "^8",
    "typescript": "^5.5.0", "vitest": "^2.0.0"
  }
}
```

### 1.2 `tsconfig.json`
ES2022 + `module: NodeNext` + `moduleResolution: NodeNext`, `strict`, `declaration: true`, `declarationMap`, `outDir: "./dist"` (for future build). **No DOM lib** (browser compat is opt-in via the ws factory, not via `lib`).

### 1.3 Source layout

```
sdk/node_sdk/src/
├── index.ts                          # public surface (re-exports)
├── _logger.ts                        # getLogger(name) → thin console wrapper
├── common/
│   ├── errors.ts                     # ErrorCode map + GatewayError (fromMessage, isTerminal)
│   ├── models.ts                     # SessionConfig/SessionStarted/AllDone/EOS/EOSAck + BaseStreamResult
│   ├── wsFactory.ts                  # WSLike type + createWebSocket() (ws vs global)
│   ├── protocol.ts                   # BaseProtocol: callback registry + emit() with error isolation
│   ├── baseStreamProtocol.ts         # BaseStreamProtocol: on_result/skipped/error/session/all_done + handleCommonMessage
│   ├── baseClient.ts                 # BaseWSClient: lifecycle, sendEos, close
│   └── baseStreamClient.ts           # BaseStreamClient: buildUrl(), connect(), sendAudioChunk(), streamBytes()
├── audio/
│   ├── pcm.ts                        # float32ToPcm16 — ported verbatim from web src/lib/pcm.ts
│   └── chunk.ts                      # computeChunkSizeBytes (from python io.py)
└── v1/asr/stream/
    ├── sharedModels.ts               # Result, Skipped (interfaces matching JSON wire format)
    ├── presets.ts                    # VAD_PRESETS {1..4} + resolveVadPreset (from python)
    ├── url.ts                        # buildUrl(params, {host, port, protocol}) (from web src/api/asr.ts)
    ├── transcribe/
    │   ├── protocol.ts               # TranscriptionProtocol extends BaseStreamProtocol
    │   ├── models.ts                 # TranscriptionResult extends BaseStreamResult
    │   └── client.ts                 # TranscriptionClient extends BaseStreamClient
    └── translate/
        ├── protocol.ts               # TranslationProtocol (common dispatch only; TTS hooks stubbed)
        ├── models.ts                 # StreamResult (TTS fields stubbed)
        └── client.ts                 # TranslationClient (target_language, side path segment)
```

### 1.4 Porting map (source → target)

| Source (web/ui/asr) | → Target (node_sdk) | Notes |
|---|---|---|
| `src/lib/pcm.ts` | `src/audio/pcm.ts` | verbatim |
| `src/api/asr.ts` types (`SessionStartedMessage`, `ResultMessage`, `SkippedMessage`, `ErrorMessage`, `AsrMessage`) | `src/common/models.ts` + `src/v1/asr/stream/sharedModels.ts` | split per-channel-shape spot in python |
| `src/api/asr.ts` `buildUrl` | `src/v1/asr/stream/url.ts` | parametrize host/port/protocol, drop `import.meta.env` (UI injects) |
| `src/api/asr.ts` `connect/sendAudio/sendEos/disconnect` | `src/common/baseStreamClient.ts` (connect/sendAudioChunk) + `baseClient.ts` (sendEos/close) | async, factory-injected ws |
| `src/hooks/useWebSocket.ts` connection logic | inlined into `BaseStreamClient.streamBytes()` | React stripped; callbacks replace setState |
| `python_sdk/.../errors.py` | `src/common/errors.ts` | new, port from python |
| `python_sdk/.../presets.py` (VAD) | `src/v1/asr/stream/presets.ts` | new, port from python |

### 1.5 Key design points

- **`WSLike`** interface: `{ readyState, send(data), sendBinary(bytes), close(code?), onopen, onmessage, onclose, onerror }`. Implementations:
  - `nodeAdapter(ws: WebSocket)` from `new (require('ws'))(url)` — coerce `binaryType='arraybuffer'`, wrap `Buffer`↔`ArrayBuffer` on send.
  - `browserAdapter(ws: WebSocket)` — pass-through; sets `binaryType='arraybuffer'`.
  - `createWebSocket(url, { factory? })`: auto-detects env if no factory supplied.
- **`streamBytes(audioData: Uint8Array | ArrayBuffer, opts?: { timeout?: number; rtfx?: number }): Promise<StreamResult>`**: async loop mirroring python — send chunk, await drain via ws listeners, on EOS loop until AllDone. Returns an aggregate result object.
- **Callbacks**: each protocol exposes `onResult(fn)`, `onSkipped(fn)`, `onError(fn: (e: GatewayError) => void)`, `onSessionStarted(fn)`, `onAllDone(fn)`. Multiple subscribers supported (mirrors python `defaultdict(list)`).
- **Translate path segment**: `TranslationClient` accepts `side? = 'conversation'` → URL `/v1/asr/stream/translate/${side}` (mirror python + spec).

---

## 2. Tests port (`sdk/node_sdk/tests/`)

| Source | Target |
|---|---|
| `tests/unit_tests/asr.test.ts` (buildUrl variants) | `tests/unit/url.test.ts` (adapt — host/port injected) |
| `tests/unit_tests/pcm.test.ts` | `tests/unit/pcm.test.ts` |
| `tests/unit_tests/pcm_stream.test.ts` | `tests/unit/pcm_stream.test.ts` |

New tests to add (low-cost parity):
- `tests/unit/errors.test.ts` (GatewayError.fromMessage roundtrip, isTerminal).
- `tests/unit/presets.test.ts` (resolveVadPreset — valid + invalid keys).

Integration tests (drive real gateway) **deferred** — they belong in node_sdk once `streamFile` exists, but Phase 1 client is callable; just no WAV loader yet.

---

## 3. `web/ui/asr` migration

### 3.1 Dependency wiring
`server/web/ui/asr/package.json`:
- Add `"alt_gateway": "file:../../sdk/node_sdk"` to `dependencies`.
- Add `ws` types implicit via alt_gateway transitive (no direct UI dep).
- `bun install` will symlink the local pkg.

### 3.2 File changes
| File | Action |
|---|---|
| `src/api/asr.ts` | **delete** — import types/`buildUrl` from `alt_gateway`. Re-export if needed for churn-minimization. |
| `src/lib/pcm.ts` | **delete** — import from `alt_gateway`. |
| `src/hooks/useWebSocket.ts` | **rewrite** — instantiate `TranscriptionClient`/`TranslationClient` from `alt_gateway`. Map `onResult/onSkipped/onError/onSessionStarted/onAllDone` callbacks to `setMessages(prev => [...prev, msg])`. `connect()` → `await client.connect()`. `sendAudio()` → `client.sendAudioChunk(buf)`. `sendEos()` → `client.sendEos()`. `reconnect()` → `close()` + new client. WebSocket factory auto-selects browser global. |
| `src/hooks/useLiveMic.ts` | **unchanged** (browser-only capture; calls `ws.sendAudio(chunk)` via hook). |
| `src/pages/TranscribeTest.tsx` | minor: call `ws.connect(params)` still works via hook API parity; may need to expose a `streamBytes` Promise wrapper for non-file streaming (mic-driven, so differs from python pattern). |
| `src/fixtures/dummy-transcribe.ts` | **keep** (UI-only fixtures with sessionId — not SDK concern). |
| `tests/unit_tests/asr.test.ts`, `pcm*.test.ts` | **delete** (moved to node_sdk). |
| `tests/integration_tests/*`, `tests/libs/*` | **unchanged** (Playwright UI tests). |

### 3.3 Mic streaming caveat
`useLiveMic` continuously feeds chunks via the hook callback (not via `streamBytes`, which is for preloaded buffers). The node_sdk client must support **push-mode audio** (already designed: `sendAudioChunk()` works standalone, EOS appended at end). The hook wires mic → `sendAudioChunk`, then calls `sendEos` on stop — same as web today. `streamBytes` is a convenience for file/buffer in Node; UI uses push mode.

---

## 4. Validation gates
1. `cd sdk/node_sdk && bun install && bun run typecheck && bun run test:unit` — clean.
2. `cd server/web/ui/asr && bun install && bun run typecheck && bun run test:unit` — clean.
3. (If gateway running) `cd server/web/ui/asr && bun run test` — Playwright integration still green.
4. Visual smoke: open UI, hit Record → Result/Skipped/Error cards still render (regression check after hook rewrite).

---

## 5. Explicitly out of scope (Phase 2 candidates)
- TTS channel (`v1/tts/stream/*`).
- WAV file I/O (`audio/wavIo.ts`) → enables `client.streamFile()`.
- VAD/TTS CLI tools (`_cli.ts`).
- Audio playback backends.
- AsyncIterable client variant.
- TypeScript build step / npm publish.
- Sync-style API (JS doesn't need it; deferred).

---

## 6. Risks & mitigations
| Risk | Mitigation |
|---|---|
| `ws` (Node) `Buffer` vs browser `ArrayBuffer` type mismatch | Centralize in `WSLike.sendBinary` adapters; convert at boundary. |
| `useWebSocket` rewrite breaks UI | Keep hook's external API (state/messages/connect/sendAudio/sendEos/disconnect/reconnect/clearMessages) identical. |
| `import.meta.env.VITE_ASR_WS_HOST` no longer available in SDK | Move host resolution to caller; web's `buildUrl` injection point stays in hook layer. |
| Vite must resolve `ws` (Node dep) when bundling UI | Vite externalizes `ws` as Node-only; browser path uses native global — factory already decouples this. May need `optimizeDeps.exclude: ['ws']` in vite config. |
| `Result.text` lang-inversion "hotfix" in python client | **Don't port the hack** — emit raw text; UI decides formatting. |

---

## Approval to proceed?

If the plan looks right, I'll execute in order:
1. Create `sdk/node_sdk/{package.json, tsconfig.json, src/**}`.
2. Port tests; run `typecheck` + `test:unit` in node_sdk.
3. Wire `web/ui/asr` to consume `alt_gateway`; rewrite `useWebSocket.ts`; delete `api/asr.ts`, `lib/pcm.ts`, unit tests.
4. Re-run web typecheck + unit + (optionally) Playwright.

Want me to begin, or adjust scope first (e.g., also port WAV I/O for `streamFile`, or wave off the UI refactor to Phase 1.5)?