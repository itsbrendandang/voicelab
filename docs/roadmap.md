# Roadmap

*Status: proposed, 2026-10-07. Now/Next/Later is ordered by risk retired, not by calendar. "Next" items start only once [discovery-plan.md](./discovery-plan.md) returns **continue**.*

## Now: prototype and pilot readiness (weeks 0–6)

Goal: a prototype that is trustworthy enough to put in front of 2–3 labs, instrumented so the pilot produces data.

| Item | Why | Done when |
|---|---|---|
| **Cascaded voice loop**: browser mic → 16 kHz PCM over WS → streaming STT (Deepgram / ElevenLabs, Web Speech fallback) → safety screen → Claude + tools → sentence-chunked TTS, with barge-in | Core experience | p50 < 1.0 s end of speech → first audio with no tool call, on lab Wi-Fi |
| **Deterministic calculators** (C1V1, serial dilution, molarity, master mix, cell seeding), unit-aware | The numbers are the product | Golden test suite passes 100%; units are dimension-checked |
| **Numeric provenance check + deterministic speech rendering of numbers** | Opus 5.5 can't be forced to call a tool; this catches numbers the model makes up | No spoken number without a source in the tool result, SOP or user utterance (tested) |
| **Safety screen v1** (incompatibilities, unsafe practices, severe-hazard reminders) | Guardrail before the LLM | Fixtures in CI; false-positive rate measured on recorded lab speech |
| **Structured SOPs**: YAML schema, 6–9 pilot SOPs, Claude PDF→YAML conversion with human review | Grounding, ranges, timers | Review time per SOP measured; every SOP approved and hashed |
| **Measurement logging + out-of-range deviations** | Real-time feedback | Range check from spec; deviation events in the run log |
| **Event-sourced run log → run record** (Markdown/PDF, ELN-pasteable) | Records and pilot metrics | Every pilot metric in the discovery plan computable from the log |
| **Keyterms from the SOP**, plus lab-specific extras | Jargon accuracy | Keyterm recall measured on the jargon set |
| **PTT default, hands-free opt-in, wake phrase** | Privacy in shared labs | Consent flow and visible listening state |
| **Eval harness v0**: calculations, STT jargon/numeric WER, SOP grounding Q&A, safety rules, per-stage latency | Lets us change providers or models without fear | One command runs everything; results stored per commit |

## Next: after a "continue" decision (months 2–6)

### 1. ELN / LIMS integrations

Export the run record as a **draft** entry the scientist reviews and signs in their system of record. We don't try to become the ELN.

| Target | Why first | Integration shape |
|---|---|---|
| **Benchling** | Dominant in biotech; Benchling AI is desk-side, so we complement it | Benchling API / app: create a notebook entry draft, attach structured tables (calculations, measurements) |
| **Labguru** | Mid-market biotech and academia | REST API: experiment/protocol entries |
| **LabArchives** | Academic standard | API: notebook page + attachments |
| Generic | Long tail | PDF + JSON export; email-to-notebook |

Later: **import** SOPs and protocols from the ELN, so SOP conversion starts from their templates.

### 2. Instrument data ingestion

Typing readings in or reading them aloud is a source of error. Read the instrument directly where it's cheap.

| Instrument | Path | Notes |
|---|---|---|
| Balances (Mettler Toledo, Sartorius) | USB/RS-232 serial; **Web Serial API** in Chromium-based browsers, or a small local agent | Mettler MT-SICS-style command sets are common; "log weight" pulls a stable reading |
| pH meters | Serial / USB HID | Same pattern as balances |
| Plate readers (BCA, Bradford, ELISA) | Watch-folder for exported CSV/XLSX → parse → standard curve → per-well concentrations | Deterministic curve fit; R² checked against the SOP spec |
| Spectrophotometers (NanoDrop-class), cell counters (Countess-class) | Export files or vendor APIs | Pull A260/280 and 260/230; viable cells/mL into the seeding calculator |
| Standardization | **Allotrope Simple Model (ASM)** JSON as the internal interchange format; consider SiLA 2 later for control | Positions us for LIMS/data-lake customers |

### 3. Multi-user benches and shared spaces

- Per-user login, with headset pairing tied to the operator for attribution (no voiceprints).
- Shared runs with handoffs ("Maria took over at step 7"); timers shared at the bench or room level.
- Several people talking near one mic: rely on close-talk headsets and PTT rather than diarization.

### 4. On-device wake word and VAD

- Wake phrase and VAD in the browser or a local agent (openWakeWord / Porcupine-class, Silero / Moonshine-class VAD) so silence and non-addressed speech never leave the device.
- A local first-pass safety screen on an on-device transcript; cloud STT only for addressed speech.
- This cuts STT cost and closes the main privacy objection.

### 5. Offline / edge mode

- The deterministic core (SOP navigation, calculators, timers, safety rules, run log) runs **without the network**.
- Offline "command mode": a small grammar ("next step", "repeat", "start timer 30 minutes", "log pH 7.42") through on-device STT, with no LLM needed.
- Sync the run log when back online. This prepares the ground for air-gapped GMP suites.

### 6. Headset and hardware choices

Pick by test, not by spec sheet. Run a 1-week bake-off in a BSC (up to roughly 67–69 dBA) and at an open bench with a vortexer and centrifuge running.

| Option | For | Against |
|---|---|---|
| Close-talk boom-mic headset, one ear open (Jabra Engage/Evolve-class) | Best signal-to-noise; proven in call centres | Comfort over 4 h; fit under face shields |
| Bone-conduction with boom mic (Shokz OpenComm-class) | Ears stay open for alarms and colleagues; fits with goggles | Lower TTS volume in loud rooms |
| Lavalier / clip mic + small speaker | No head gear | Picks up the room; poor in hoods |
| Tablet / laptop mic only | Zero setup | Fails in noise; nearby people hear everything |

Accessories: a foot pedal for PTT, and wipeable covers for anything inside the BSC. Decision metric: numeric-token error and user comfort rating.

### 7. Evals as a product gate

- **Calculations:** exhaustive property tests (unit conversions, edge cases), plus spoken-input end-to-end tests.
- **STT:** a per-lab jargon set; WER, keyterm recall and numeric-token error; rerun on every provider change.
- **Grounding:** SOP Q&A with answers bound to step IDs; "not in the SOP" refusals measured.
- **Safety:** rule fixtures, plus replayed pilot transcripts for false positives.
- **Latency:** per-stage p50/p95 regression thresholds.
- **Models:** pin the model ID; any model or prompt change must pass all of the above.

### 8. Provider work (from [providers.md](./providers.md))

TTS abstraction plus Cartesia and Aura-2 alternates; Eleven v4 Turbo A/B; an AssemblyAI U3.5 Pro RT test (keyterms per step); the calculation fast-path read-back; a one-week ElevenLabs Agents + Claude comparison.

### 9. Commercial and compliance readiness

DPA and subprocessor list, EU region, retention controls, start SOC 2 Type I, per-lab safety-rule configuration reviewable by the Chemical Hygiene Officer.

## Later: 6–18 months, gated on paying research customers

### Manufacturing and GxP

- **Deterministic workflow mode:** an SOP or batch-record state machine; the LLM is advisory only (draft Annex 22 posture). Second-person verification, Part 11 e-signatures, and a validation package (see [safety-and-compliance.md](./safety-and-compliance.md)).
- **MES / eBR integration** (Tulip, Apprentice Tempo, Körber PAS-X, Emerson Syncade, Siemens Opcenter), via APIs and ISA-95/OPC UA where needed. Partner rather than compete with the MES.
- **Operator guidance in gowning:** cleanroom-compatible headsets, multilingual STT/TTS, plant-noise robustness, on-prem or edge deployment (self-hosted Deepgram/Speechmatics/Aura-2/Rime; Claude through a private cloud deployment).

### Robotics and cobots, with confirmation gates

- Pipeline: voice → intent → **proposed action rendered on screen and read back** → **explicit physical confirmation** (button or hold-to-run) → the robot controller runs a **pre-validated program** with parameters inside validated bounds.
- Never stream speech into motion. Robot safety remains in rated hardware and controllers (ISO 10218, ISO/TS 15066).
- First targets: liquid handlers (Opentrons-class: "run the normalization protocol for these 24 samples" → a reviewed protocol) before arms.

### Protocol-execution analytics

- Per-lab dashboards: step timings, deviation heatmaps, the "confusion map" (questions per step), timer overruns, safety triggers.
- Linking runs to outcomes (assay pass/fail, yields) to find execution factors that predict failure.
- Cross-lab benchmarks **only** with explicit contractual aggregation rights and de-identification. Possible partnerships with kit vendors (voice-ready protocols, failure analytics).

### Other

- Vision: camera at the bench for tube or plate state, only if voice-only proves insufficient and the privacy story holds.
- Smart-glasses client (Android XR / AI glasses) once a platform ships at scale; it reuses the same server.

## Explicitly not doing (for now)

- Building our own ELN or LIMS.
- Speech-to-speech as the primary loop.
- Voice biometrics or emotion analysis.
- Direct speech-to-robot motion.
- Cross-lab data products before single-lab value is proven.
