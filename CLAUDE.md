# voicelab: notes for Claude

Real-time voice assistant for lab benches. TypeScript npm workspaces, Node 22, ESM.

- `packages/core`: pure, browser-safe domain logic and the WebSocket protocol (`src/protocol.ts`). `@voicelab/core/node` is the only place allowed to touch the filesystem.
- `apps/server`: Node server run with `tsx` (no build step). The session pipeline is in `src/session.ts`, agents and tools in `src/agent/`, and STT/TTS adapters in `src/providers/`.
- `apps/web`: Vite + React, hand-written CSS, no UI or icon libraries. Imports from core must be `import type` (except the local constants in `src/protocol.ts`).

## Rules that matter
- Numbers the assistant speaks must come from the calculators in `packages/core/src/calc`. Never add arithmetic to prompts or agents. Add or extend a calculator and expose it as a tool in `apps/server/src/agent/tools.ts` (both agents share that registry).
- The safety screen (`screenUtterance`) runs before any agent on every utterance. Keep it deterministic and keep its false-positive rate low; `safety.test.ts` has a list of ordinary lab utterances that must stay quiet.
- State changes go through `ExperimentRun` (event-sourced). Never mutate `ExperimentState` directly.
- Keep the Claude system prompt byte-stable (prompt caching). Per-turn context goes in the `<bench_state>` block of the user turn.
- Changing the protocol means updating `packages/core/src/protocol.ts`, `apps/server/src/protocol-schema.ts` (zod validation) and the web reducer together.

## Commands
`npm test` · `npm run typecheck` · `npm run build` · `npm start` (serves the built UI on :8787) · `npm run dev`
