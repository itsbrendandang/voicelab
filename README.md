# voicelab

A real-time voice assistant for the lab bench. Think Wispr Flow or ElevenLabs,
but for scientists with gloves on.

Talk to it while you work. It walks you through the SOP step by step, does
dilution and molarity math, checks the readings you say out loud against the
SOP's expected ranges, flags when the experiment is drifting, catches unsafe
combinations before you make them, runs timers, and turns the whole session
into an ELN-ready run record.

> **Status: exploratory prototype.** The sample SOPs are demo content, not
> validated protocols. The assistant is an aid, not a safety system. See
> [docs/safety-and-compliance.md](docs/safety-and-compliance.md).

```
"How much of the 2 mg/mL BSA stock do I need for 1 mL at 0.5?"
  → Add 250 microliters of stock to 750 microliters of diluent.     (calculator tool, working shown on screen)

"I'm going to pour the bleach into the acid waste."
  → Stop. Bleach and acid release toxic chlorine gas. …              (deterministic rule, spoken before the LLM runs)

"Absorbance of the blank is 1.9."
  → Out of range; expected 0.3–0.65. Logged a deviation.             (SOP spec + troubleshooting)
    A high blank usually means old or contaminated reagent…
```

## Quick start

```bash
npm install
npm run build        # builds the bench UI
npm start            # http://localhost:8787
```

That runs fully offline with **no API keys**: browser speech recognition and
synthesis (Chrome/Edge) plus a rule-based agent that uses the same calculator,
SOP and safety tools. For the full pipeline, copy `.env.example` to `.env` and add:

| Key | Enables |
|---|---|
| `ANTHROPIC_API_KEY` | Claude (`claude-opus-5-5`, low effort) as the conversational agent with lab tools |
| `DEEPGRAM_API_KEY` | Server-side streaming STT (Nova-3) with keyterms generated from the active SOP |
| `ELEVENLABS_API_KEY` (+ `ELEVENLABS_VOICE_ID`) | Low-latency streaming TTS; Scribe realtime STT is also available (`VOICELAB_STT=elevenlabs`) |

When developing, `npm run dev` runs the server on :8787 and the Vite UI on
http://localhost:5173 with hot reload.

### Docker

```bash
cp .env.example .env               # optional; with no keys it runs fully offline
docker compose up --build          # http://localhost:8787
docker compose --profile dev up dev   # hot reload: UI :5173, server :8787, source mounted
```

The image serves the built UI and the server on one port. Keys come from `.env`
at runtime and are never baked in. SOPs are mounted read-only from `./sops`, so
you can edit them without rebuilding (restart to reload). Run logs persist in the
`voicelab-data` volume. Ports bind to `127.0.0.1` by default. To reach the app
from a bench tablet on the lab network, publish on `0.0.0.0`, set
`VOICELAB_ACCESS_TOKEN`, open `http://<host>:8787/?token=<token>`, and put TLS
in front, since browsers only allow the microphone on https or localhost. Behind a
TLS-inspecting proxy, build with
`docker build --secret id=extra_ca,src=/path/to/proxy-ca.pem .`.

| Command | What it does |
|---|---|
| `npm test` | All unit + integration tests (vitest) |
| `npm run typecheck` | `tsc` across core, server and web |
| `npm run sop:import -w @voicelab/server -- path/to/sop.pdf` | Converts an existing PDF, text or Markdown SOP into the structured YAML format using Claude structured outputs (review before use) |

## How it works

```
mic ─► STT (streaming) ─► safety screen ─► wake gate ─► Claude + lab tools ─► sentence chunker ─► TTS ─► speaker
          │                    │ danger: speak now, pin alert        │
          │                    ▼                                     ▼
          └──────────────► event log (JSONL) ◄── calculators · SOP · measurements · timers
                               │
                               └──► live UI state · run record (Markdown, ELN-ready)
```

- **Numbers come from tools.** Claude is told never to do arithmetic. A
  provenance check also flags any spoken number that doesn't trace back to a
  tool result, the SOP or the operator's own words.
- **Safety doesn't depend on the LLM.** A deterministic screen runs on every
  utterance first, including ones the wake phrase filters out.
- **SOPs are structured** (YAML): expected measurement ranges, GHS hazards,
  timers, critical steps, checks and troubleshooting. That is what lets the
  assistant say "that's wrong" instead of just reading text back.
- **Everything is an event.** The same log drives the UI, persistence, the run
  record and, later, analytics on how protocols are actually executed.

Details: [docs/architecture.md](docs/architecture.md).

## Repository layout

```
packages/core   protocol types, SOP schema/search, unit-aware calculators, safety rules, experiment state, run report
apps/server     HTTP + WebSocket server, STT/TTS adapters, Claude + offline agents, tool registry, SOP import CLI
apps/web        bench UI: mic capture, PCM playback, barge-in, step hero, alerts, calc cards, run record
sops/           demo SOPs: Bradford assay, PCR setup, HEK293 passaging, 1 M Tris-HCl pH 8.0
docs/           architecture, provider research, product vision, safety & compliance, discovery plan, roadmap
```

## Docs

- [Architecture](docs/architecture.md): the pipeline, design decisions, latency budget
- [Voice providers](docs/providers.md): STT/TTS/speech-to-speech landscape (Oct 2026) and what to try next
- [Vision](docs/vision.md): personas, bench scenarios, the data asset, competition, manufacturing expansion
- [Safety & compliance](docs/safety-and-compliance.md): guardrails, GLP/GMP, 21 CFR Part 11, privacy
- [Discovery plan](docs/discovery-plan.md): riskiest assumptions, interview guide, pilot design
- [Roadmap](docs/roadmap.md)

## Known gaps

- The Deepgram, ElevenLabs STT and ElevenLabs TTS adapters were written without
  network access to the vendors' docs. Endpoints and parameters marked
  `// VERIFY:` need checking against a live key.
- The Claude agent path is unit-tested with a stubbed client. It hasn't been run
  against the live API yet.
- Wake-word detection is transcript-based, not on-device.
- One operator per session. No auth, no multi-user benches, no ELN/LIMS
  integrations yet (see the roadmap).
