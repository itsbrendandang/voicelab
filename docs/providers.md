# Real-time voice providers: landscape and recommendation

*Status: research snapshot as of 2026-10-07. Owner: research/product.*

**How to read this doc.** Prices and latency claims move quarterly. The network proxy blocked direct fetches of most vendor sites (deepgram.com, elevenlabs.io, assemblyai.com, cartesia.ai, docs.livekit.io), so figures come from search-indexed vendor pages and third-party aggregators. Vendor-run benchmarks are labelled as such. ⚠ marks a figure that sources contradict or that I could not verify. Re-check every number on the vendor's pricing page before signing anything.

---

## TL;DR

1. **Keep the cascaded pipeline** (STT → deterministic safety screen → Claude + tools → TTS). For this product, the safety screen in the loop, deterministic calculations, and owning the event stream all count for more than the ~200–400 ms a speech-to-speech model might save.
2. **STT:** make **Deepgram Nova-3 / Flux** the primary, with keyterms generated from the SOP YAML. Keep **ElevenLabs Scribe v2 Realtime** as the second provider. Before committing, run AssemblyAI **Universal-3.5 Pro Realtime** (it can update keyterms mid-stream) and **Soniox** against our own lab-jargon eval.
3. **LLM:** use `claude-opus-5-5` with `effort: "low"` set explicitly, since the default is `medium`. Cache the system prompt, tools and SOP with a 1-hour TTL. Measure time to first token. Fast mode or a cheaper router model are options to test, not to assume.
4. **TTS:** stay on ElevenLabs but A/B **Eleven v4 Turbo** (launched 2026-09-28) against Flash v2.5. Put **Cartesia Sonic** and **Deepgram Aura-2** behind the same interface as alternates. Use pronunciation dictionaries for reagent names and units.
5. **Experiment, don't adopt:** run **ElevenLabs Agents with Claude as a custom LLM** for a week to compare turn-taking feel against our own pipeline. Don't build on OpenAI Realtime, Gemini Live or Hume EVI as the primary path.

---

## 1. What "good" means at a lab bench

| Requirement | Why it matters here | What to look for |
|---|---|---|
| Vocabulary biasing | "Tris-HCl", "EDTA", "HEK293", "DMEM", "Eppendorf", "µL", catalog names. Generic models turn "Tris" into "trees" and "HEK" into "heck". | Keyterm or phrase lists (count limits, cost, whether they can change mid-session) |
| Numbers and units | A misheard "fifteen"/"fifty" or "micro"/"milli" causes a 3- or 1000-fold error. | Numeric formatting, unit normalization, confidence scores per word |
| Endpointing | People pause mid-number ("add… two point… five mils"). If the system cuts in early it acts on a partial number. | Semantic or end-of-turn models, a tunable silence timeout, push-to-talk |
| Noise | Biosafety cabinets run up to roughly 67–69 dBA at the operator under NSF/ANSI 49 ([2024 ballot draft](https://standards.nsf.org/higherlogic/ws/public/download/76063/49i177r3%20-%20Noise%20Level%20-%20JC%20Memo%20and%20Ballot.pdf), ⚠ final text not checked), plus vortexers, centrifuges and fume hoods. | Close-talk headset support, noise suppression, accuracy measured in noise (no vendor publishes lab-noise numbers) |
| Data handling | SOPs and spoken observations are customer IP. | Zero-retention or training opt-out, BAA where needed, region pinning, self-hosting |
| Swap-ability | Prices and quality leapfrog every quarter. | Plain WebSocket APIs, no lock-in to an orchestration platform |

---

## 2. Streaming speech-to-text (STT)

| Provider / model | Latency claim | Price (source date) | Protocol | Custom vocab | Retention / compliance | Self-host |
|---|---|---|---|---|---|---|
| **Deepgram Nova-3** | Sub-300 ms (vendor) | ~$0.0077/min streaming PAYG; sources range $0.0048–0.009 ⚠ ([aggregators, mid-2026](https://convertaudiototext.com/blog/deepgram-nova-3-explained)); keyterms ≈ +$0.0013/min ([Soniox comparison](https://soniox.com/pricing/stt/soniox-vs-deepgram)) | WebSocket `/v1/listen` | **Keyterm prompting**: about 100 terms, hard cap of 500 tokens per request, streaming supported ([docs](https://developers.deepgram.com/docs/keyterm)) | `mip_opt_out=true` excludes data from training but forfeits the 50% Model Improvement Program discount ([docs](https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program)); BAA on request; SOC 2 Type 1 and 2 ([compliance](https://developers.deepgram.com/docs/data-privacy-compliance)) | Yes (enterprise; cloud, VPC or on-prem) |
| **Deepgram Flux** | Vendor: under 300 ms end-of-turn. A Pipecat test run by AssemblyAI, a competitor, measured 568 ms mean and 1,319 ms p95 ([AssemblyAI](https://assemblyai.com/blog/assemblyai-vs-deepgram-best-voice-agent-api)) | ~$0.0065/min English ([LLM Reference](https://www.llmreference.com/model/flux-asr)); $0.0077 via Cloudflare ⚠ | WebSocket `/v2/listen` | Keyterms supported (same 500-token cap) | Same as Nova-3 | Yes |
| **ElevenLabs Scribe v2 Realtime** | Under 150 ms (vendor says under 100 ms) ([product page](https://elevenlabs.io/realtime-speech-to-text)) | ~$0.28–0.39/hr depending on plan ⚠ | WebSocket | Keyterms work in realtime and are passed at connect time ([docs](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/batch/keyterm-prompting.md)). Realtime limit ⚠: 50 terms × 20 characters vs 100 terms, depending on source. Batch allows 1,000. | Zero Retention Mode (enterprise, `enable_logging=false`); BAA for eligible customers ([ZRM](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode)); EU and India residency | No |
| **AssemblyAI Universal-Streaming** | Not verified | $0.15/hr; keyterms +$0.04/hr in English ([pricing.md](https://www.assemblyai.com/pricing.md)) | WebSocket | Up to 100 keyterms, ≤50 characters each | SOC 2 Type 2, ISO 27001, EU (Dublin) residency, BAA ([security](https://www.assemblyai.com/security)) | Self-hosted streaming, $20k upfront commitment ([docs](https://assemblyai.com/docs/streaming/self-hosted-streaming)) |
| **AssemblyAI Universal-3.5 Pro Realtime** | Not verified | $0.45/hr, keyterms included | WebSocket | **Up to 100 keyterms, updatable mid-stream**, so they can change per SOP step | Same; real-time diarization added 2026-03-03 | Same |
| **OpenAI** `gpt-4o-transcribe` / `-mini` / `gpt-realtime-whisper` | Not published | $0.006 / $0.003 / ~$0.017 per min ([aggregators](https://diyai.io/ai-tools/speech-to-text/openai-whisper-api-pricing-2026/)) ⚠ | Realtime API (WebSocket/WebRTC) | Free-text `prompt` only, not a keyterm list. The prompt is not supported on `gpt-realtime-whisper` ([API ref](https://developers.openai.com/api/docs/api-reference/realtime)). Has `near_field` noise reduction. | `/v1/realtime` is on the HIPAA endpoint list once ZDR or Modified Abuse Monitoring is provisioned and a BAA is signed ([PDF, Jan 2026](https://cdn.openai.com/osa/hipaa-endpoints.pdf)) | No |
| **Speechmatics** | ~400–700 ms finals (vendor pages disagree) | Not verified; free tier 1,200 RT min/mo ([CostBench](https://www.costbench.com/software/ai-transcription-apis/speechmatics/)) | WebSocket | Custom dictionary of 1,000 words with `sounds_like` variants, included in price ([vendor](https://www.speechmatics.com/how-we-compare/assemblyai-alternative.md)) | Enterprise terms | **Yes**: containers, virtual appliances, on-device |
| **Google Chirp 3** (STT V2) | Not verified | $0.016/min for the first 500k min/mo, V2 standard ([pricing](https://cloud.google.com/speech-to-text/pricing/)) | gRPC `StreamingRecognize` | Speech adaptation / phrase biasing is GA for Chirp 3 | Google Cloud terms and BAA | No (Distributed Cloud not evaluated) |
| **Azure AI Speech** | Not verified | ~$1/hr real-time, $1.20/hr custom, plus endpoint hosting ⚠ ([third party](https://blocksentient.com/review/microsoft-azure-speech-service/)) | WebSocket SDK | Phrase lists and Custom Speech training | Azure terms and BAA | Connected and disconnected containers (annual commitment) ([docs](https://learn.microsoft.com/en-my/Azure/ai-services/speech-service/speech-container-overview)) |
| **Soniox** `stt-rt-v4`/`v5` | ~250 ms median to final with local VAD (Pipecat) | ~$0.12/hr real-time, context included ([Soniox](https://soniox.com/compare-stt/soniox-vs-speechmatics)) | WebSocket | **Context object** (terms, general context, free text) supplied at request time | Not verified | On-prem evidence only from 2021 ⚠ |
| **On-device** (WhisperKit, Moonshine v2, whisper.cpp, Transformers.js/WebGPU, NVIDIA Parakeet) | WhisperKit: 0.46 s, 2.2% WER (authors' own numbers) ([arXiv](https://arxiv.org/html/2507.10860v1)) | Free (compute only) | Local | Whisper `initial_prompt` only; no real keyterm biasing | Audio never leaves the device | Yes, by definition |

**Notes**

- **Deepgram is our default.** It has the cheapest streaming keyterm support with a documented cap, true self-hosting for the eventual GMP or air-gapped customer, and Flux's end-of-turn model, which fits hands-free mode. The 500-token cap means keyterms must be ranked: current SOP reagents and aliases first, then equipment, then the lab's own catalog names. Keyterms are fixed at connect time, so reconnect when the SOP changes.
- **Scribe v2 Realtime stays as the second provider**, since it is already integrated and keyterms are now documented for realtime. LiveKit's model list reportedly marks `scribe_v2_realtime` as deprecated; I could not confirm this against ElevenLabs' own pages, so watch for a successor model ID.
- **AssemblyAI U3.5 Pro Realtime is the most interesting newcomer for us.** Keyterms that can be swapped mid-stream map directly onto "current step's reagents". It is also the most expensive option here, at $0.45/hr.
- **OpenAI transcription** takes a descriptive prompt ("Expect molecular biology terms such as Tris-HCl…"), which is weaker and less predictable than a keyterm list. Community reports say turning on `noise_reduction` together with semantic VAD added latency ([forum](https://community.openai.com/t/realtime-api-with-noise-reduction-has-sudden-increase-of-latency/1256390)).
- **On-device STT is not the primary path**, because it has no real jargon biasing. It is the right tool for (a) wake-phrase and VAD gating, (b) a local first-pass safety screen, so non-addressed speech never leaves the bench (see [safety-and-compliance.md](./safety-and-compliance.md)), and (c) an offline fallback.
- **Normalize after STT whatever the vendor.** Map spoken forms deterministically, using a lexicon built from the SOP aliases: "tris h c l" → "Tris-HCl", "micro liters"/"mics" → "µL", "ten to the six" → "1e6". Treat numbers with low per-word confidence as unconfirmed and read them back.

---

## 3. Text-to-speech (TTS)

| Provider / model | Latency | Price (source date) | Protocol | Pronunciation control | Retention / compliance | Self-host |
|---|---|---|---|---|---|---|
| **ElevenLabs Flash v2.5** (current) | ~75 ms model only. Vapi measured 197 ms median time to first audio including network, June 2026 ([Vapi](https://humannessindex.vapi.ai/models/elevenlabs-flash-v2-5)) | $0.05/1k chars PAYG ([aggregator, Jun–Jul 2026](https://www.llmreference.com/model/eleven-flash-v2-5)) | WebSocket input streaming | Pronunciation dictionaries | ZRM via `enable_logging=false` (enterprise); BAA | No |
| **ElevenLabs Eleven v4 Turbo** (2026-09-28) | ~100 ms inference, ~150 ms median to first audio (vendor) ([changelog](https://elevenlabs.io/docs/changelog/2026/9/28)) | Not verified | WebSocket (`eleven_v4_turbo`) | Pronunciation dictionary shared across languages | Same | No |
| **Cartesia Sonic 3 / 3.5 / 3.6β** | 40–90 ms advertised; independent Coval P50 ~188 ms ([eesel](https://www.eesel.ai/blog/cartesia-sonic-3-pricing)); vendor changelog says ~190 ms median for Sonic 3 | ~$37–40 per 1M chars implied by plan prices ⚠ ([smallest.ai](https://smallest.ai/blog/cartesia-pricing-plans-cost-what-you-get-in-2026)) | WebSocket | Not verified (docs blocked) | Not verified | Not verified |
| **Deepgram Aura-2** | Vendor: ~90 ms TTFB steady state, p95 under 200 ms. A third party measured 313 ms P50 ([summary](https://rywalker.com/research/deepgram-aura)) | $0.030/1k chars PAYG | WebSocket / REST | Speed and `pronounce` controls added April 2026 ([changelog](https://developers.deepgram.com/changelog/2026/4/30)) | Same contract as Deepgram STT | **Yes** |
| **OpenAI gpt-4o-mini-tts** | ~0.8–1.0 s in two measurements, one run by a vendor ⚠ | ~$0.015/min (third-party conversion) ([techsy](https://techsy.io/en/blog/best-tts-apis-developers)) | HTTP streaming | Steered by instructions | ZDR / BAA as for the API | No |
| **Rime** Mist v3 / Coda | Mist ~37 ms P50 time to first audio on GPU (vendor) ([docs](https://docs.rime.ai/docs/introduction.md)) | $0.03 / $0.05 per 1k chars ([Aug 2026 blog](https://dailyaifixs.com/blog/rime-ai-pricing-2026-the-per-character-catch)) | WebSocket | **Phoneme brackets** on the Mist family. The vendor's docs say Mist v2 has custom pronunciation and Mist v3 does not yet. | Not verified | **Yes** (on-prem GPU) |
| **Hume Octave 2** | Under 200 ms (vendor) ([launch](https://hume.ai/blog/octave-2-launch)) | ~$0.025/1k chars overage after a June 2026 change (aggregator) ⚠ | WebSocket | Not verified | Not verified | No |
| **Inworld TTS 1.5** Mini / Max | Vendor: under 130 / under 250 ms P90. Vapi measured Max at 337 ms median. | $5–35 per 1M chars; sources conflict ⚠ | WebSocket | Not verified | Not verified | No |

**Notes**

- In a lab the voice should be calm, clear and moderately fast, with every digit audible. Expressive range doesn't matter. Clarity of numbers matters, as does a pronunciation dictionary: "Tris-HCl" spoken as "tris H-C-L", "µL" as "microliters", "HEK293" as "hek two-ninety-three".
- **Spell numbers out for TTS ourselves.** Never let the TTS engine guess "1.5e6 cells/mL" or "25 µL". Render the spoken string deterministically from the calculator output ("twenty-five microliters") and send that.
- Deepgram Aura-2 and Rime can be self-hosted, which matters later for air-gapped GMP suites.

---

## 4. Speech-to-speech models and voice-agent platforms

| Platform | What it is | Latency / price | Tool use | Can we keep our safety screen and Claude? | Compliance |
|---|---|---|---|---|---|
| **OpenAI Realtime** (`gpt-realtime-2.1`, `-mini`) | Native audio-in/audio-out model; WebRTC, WebSocket, SIP | Audio per 1M tokens: $32 in / $64 out (flagship), $10 / $20 (mini). Third-party estimate $0.06–0.11/min flagship with caching ([aireiter, Jul 2026](https://aireiter.com/blog/openai-realtime-api-pricing)) ⚠ | Function calling, parallel and async calls, MCP | **No.** The model hears the audio before any of our code runs, so the safety screen can only run in parallel on a side transcript, and the LLM isn't Claude | `/v1/realtime` on the HIPAA list (beta) |
| **Gemini Live** (`gemini-3.8-live`, stable Sept 2026) | Native audio model | Price not published at time of search ([analysis](https://aireiter.com/es/blog/gemini-3-8-live-api-pricing)) ⚠. Forum reports of 3–7 s responses on older 2.5 previews ([forum](https://discuss.ai.google.dev/t/live-api-5-6-second-response-latency/123254)) | Function calling; non-blocking by default | No | Google Cloud terms; 2.5 native audio is discontinued 2026-12-13 on Vertex ([docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash-live-api)) |
| **ElevenLabs Agents** | Managed STT, turn-taking and TTS around an LLM you choose | ~$0.08–0.10/min plus LLM ([CloudTalk, Jun 2026](https://www.cloudtalk.io/blog/elevenlabs-voice-agent-review/)) ⚠ | Server and client tools | **Partly.** Claude is supported, and a custom-LLM endpoint lets us put our server, including the safety screen, in the loop | HIPAA with BAA and ZRM; MCP not available under ZRM ([HIPAA doc](https://elevenlabs.io/docs/agents-platform/legal/hipaa)) |
| **Hume EVI 4-mini** | Speech-to-speech with an external LLM (Claude is Hume's default supplemental LLM) | ~$0.02–0.035/min (aggregator) ⚠ | Via the supplemental LLM | Partly | **EVI infers emotion from voice, and the EU AI Act Art. 5(1)(f) bans emotion inference on workers ([Bird & Bird](https://www.twobirds.com/en/insights/2025/global/ai-and-the-workplace-navigating-prohibited-ai-practices-in-the-eu)). A lab is a workplace. Avoid it.** |
| **Deepgram Voice Agent API** | Managed STT, LLM and TTS | BYO LLM ~$0.05–0.065/min; Standard $0.075; Advanced $0.163 (third party) ⚠ | Function calling | Partly (BYO LLM) | `mip_opt_out` supported |
| **LiveKit Agents** | Open-source framework (Apache-2.0) plus LiveKit Cloud; Node SDK is AgentsJS ([GitHub](https://github.com/livekit/agents)) | Cloud agent sessions ~$0.01/min plus models (third party) ⚠ | Any LLM, including Anthropic | **Yes.** It is a cascade we control | Cloud HIPAA with BAA on Scale/Enterprise ([HIPAA](https://livekit.com/legal/hipaa)); the semantic turn detector uses the LiveKit Model License |
| **Pipecat** | Open-source framework (BSD-2), Python; v1.12.0 released Sept 26 ([GitHub](https://github.com/pipecat-ai/pipecat)) | Self-host or Pipecat Cloud | Any LLM | Yes, but Python while our stack is TypeScript | Depends on deployment |
| **Vapi** | Hosted orchestration, mostly telephony | $0.05/min plus providers; HIPAA add-on ~$2,000/mo (third party) ⚠ | Yes | Partly | Paid HIPAA add-on |
| **Retell** | Hosted orchestration, mostly telephony | $0.07/min voice infra; realistic all-in $0.11–0.31/min ([macha](https://www.getmacha.com/blog/retell-ai-vs-vapi)) ⚠ | Yes | Partly | SOC 2 Type II; BAA |

Vapi and Retell are built for phone calls. A browser or headset at the bench gains little from them.

---

## 5. Decision: cascaded pipeline vs speech-to-speech or a managed platform

| Dimension | Cascaded (what we built) | Speech-to-speech (OpenAI Realtime, Gemini Live) | Managed platform with Claude (ElevenLabs Agents) |
|---|---|---|---|
| Safety screen before the model acts | **Yes.** Every final utterance is screened before the LLM sees it | No. Audio goes straight into the model; the screen can only run in parallel | Only through a custom-LLM hop into our server |
| Calculation correctness | Claude calls deterministic tools; the spoken number is rendered from the tool result | Tool calling exists, but the model also speaks numbers freely, and checking what it says against tool results is awkward | Same as cascaded if the custom LLM is our server |
| Choice of LLM | Claude, swappable | Locked to the vendor's model | Claude possible |
| Owning the event data | Full: transcripts, word confidences, timings, tool traces, alerts | Partial: vendor events, no per-word STT confidence | Partial: vendor logs plus ours |
| Swapping providers | Per stage | None | TTS and STT locked to the platform |
| Latency | Sum of stages; needs care (budget below) | Best case lowest; prosody and interruptions feel natural | Good; they tune turn-taking for you |
| Barge-in and turn-taking quality | We build it; it is the hard part | Excellent | Excellent |
| Cost per active minute | ~$0.01 STT + LLM tokens + ~$0.01–0.03 TTS | ~$0.06–0.11+ | ~$0.08–0.10 + LLM |
| Audit or GxP story | Clear: deterministic components can be validated and the LLM is advisory | Hard to explain to QA | Middling |

**Verdict.** Cascaded is the right call for a product whose value is *correct numbers, the right step, and safety*. Speech-to-speech wins on conversational feel, and that is not what we sell. Revisit if (a) a speech-to-speech model lets us run a synchronous pre-generation hook on its transcript, and (b) Claude ships a native audio mode.

### Latency budget (target: under 1.0 s from end of speech to first audio, p50; under 1.5 s p95)

| Stage | Target | Notes |
|---|---|---|
| End of speech → final transcript | 150–300 ms | Flux or Scribe VAD commit. Push-to-talk release removes most of this. |
| Normalization and safety screen | under 10 ms | Deterministic and in-process. Never call a network service here. |
| Claude time to first token (no tool) | 300–600 ms ⚠ measure | `effort: "low"`; system prompt, tools and SOP cached (cache reads $0.20/M on Opus 5.5). Opus 5.5 time to first token is not published, so this row is a hypothesis. |
| Tool round trip (calculator) | +20 ms tool + a second time to first token (~300–500 ms) | The calculation turn is the slow path. Mitigation below. |
| First sentence → TTS first audio | 100–250 ms | Flush on the first clause, not the first full sentence. |
| Network and playback buffer | 50–100 ms | 16 kHz PCM, small jitter buffer |
| **Total, no tool** | **~0.6–1.2 s** | |
| **Total, with a calculation** | **~1.0–1.7 s** | Over budget at p95 |

People in conversation leave gaps of about 200 ms between turns ([Stivers et al., PNAS 2009](https://www.pnas.org/doi/10.1073/pnas.0903616106)). A busy scientist tolerates more, but not dead air after asking for a number. **Mitigations, in order:**

1. **Fast path for calculations.** When the calculator tool returns, send a templated read-back to TTS straight away ("Twenty-five microliters of stock into nine seventy-five of buffer.") while Claude composes anything else. This gives deterministic text and the lowest latency.
2. **Prompt caching with a 1-hour TTL.** Bench pauses are often longer than 5 minutes, so the default TTL would expire mid-run. Pre-warm the cache when the SOP is selected.
3. **Test `speed: "fast"`.** It is a research preview on the Claude API only, $8/$40 per M tokens on Opus 5.5, with up to 2.5× output tokens per second. Measure whether it changes time to first token or only throughput.
4. **Test a cheap router model.** Run `claude-haiku-5-5` ($0.10/$0.50 per M tokens) to classify "addressed to assistant?" and the intent before invoking Opus. This is the founder's call on cost against quality, so evaluate it, don't assume it.
5. Instrument every stage into the run log (`stt.final_at`, `llm.first_token_at`, `tts.first_audio_at`) so p50/p95 per stage is a dashboard, not a guess.

**Opus 5.5 constraints that matter to us:**

- Thinking cannot be disabled; control depth with `effort`.
- Forced `tool_choice` (`any` or `tool`) returns a 400, so "always use the calculator" has to be enforced by the prompt *plus* a server-side check of where every spoken number came from (see [safety-and-compliance.md](./safety-and-compliance.md)).
- Set `eager_input_streaming: true` on tools so tool calls start sooner.

---

## 6. What to add next (ranked)

1. **A lab-jargon STT eval harness** before any vendor switch. Use 200–300 utterances recorded at real benches by 5+ speakers in hood and cabinet noise. Score WER, **numeric-token error rate**, **unit error rate** and keyterm recall. Compare Nova-3 + keyterms, Flux, Scribe v2 RT, U3.5 Pro RT and Soniox.
2. **Generate keyterms from the SOP YAML**: reagent names and aliases, equipment, units, cell lines, ranked to fit the 100-term / 500-token caps. Add per-lab custom terms.
3. **A TTS abstraction plus Cartesia Sonic and Deepgram Aura-2** as alternates; A/B Eleven v4 Turbo against Flash v2.5. Pick on p95 time to first audio and on how clearly numbers come through (blind listener test).
4. **The calculation fast path** (deterministic read-back text to TTS).
5. **A one-week ElevenLabs Agents + Claude experiment**, routed through our server as the custom LLM so the safety screen stays in the loop. Compare barge-in and turn-taking feel against our pipeline. Exit with a written comparison.
6. **On-device VAD and wake phrase** (for example Moonshine or Silero-class VAD in the browser) to cut cloud audio and improve privacy.
7. **A self-host track** for GMP and air-gapped customers: Deepgram self-hosted STT and Aura-2, or Speechmatics containers, plus Claude through a private cloud deployment. Not before the pilot proves demand.

---

## 7. Environment variables

### Implemented today (`apps/server/src/config.ts`)

A missing key degrades gracefully: STT and TTS fall back to the browser, and the LLM falls back to offline mode.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | — | Claude credentials (either one) |
| `VOICELAB_LLM` | `anthropic` | `anthropic` \| `offline` |
| `VOICELAB_LLM_MODEL` | `claude-opus-5-5` | Model ID |
| `VOICELAB_LLM_EFFORT` | `low` | Set explicitly, because the Opus 5.5 API default is `medium` |
| `VOICELAB_LLM_MAX_TOKENS` | `8000` | Per-turn output cap |
| `VOICELAB_LLM_HISTORY_TURNS` | `24` | Turns kept before history is compacted |
| `VOICELAB_STT` | `deepgram` | `deepgram` \| `elevenlabs` \| `browser` |
| `DEEPGRAM_API_KEY` | — | Deepgram STT |
| `DEEPGRAM_MODEL` | `nova-3` | Try Flux here; verify its model ID ⚠ |
| `DEEPGRAM_ENDPOINTING_MS` | `300` | Silence before a final transcript. Raise it if people pause mid-number. |
| `DEEPGRAM_UTTERANCE_END_MS` | `1000` | Utterance-end detection |
| `DEEPGRAM_LANGUAGE` | `en` | Language |
| `VOICELAB_TTS` | `elevenlabs` | `elevenlabs` \| `browser` \| `off` |
| `ELEVENLABS_API_KEY` | — | ElevenLabs STT and TTS |
| `ELEVENLABS_VOICE_ID` | premade voice | Pick a calm, clear voice for production |
| `ELEVENLABS_TTS_MODEL` | `eleven_flash_v2_5` | A/B against `eleven_v4_turbo` |
| `ELEVENLABS_TTS_SAMPLE_RATE` | `24000` | 16000 / 22050 / 24000 / 44100 |
| `ELEVENLABS_STT_MODEL` | `scribe_v2_realtime` | Realtime STT |
| `VOICELAB_SOP_DIR`, `VOICELAB_DATA_DIR`, `VOICELAB_WEB_DIST`, `VOICELAB_SERVE_WEB` | repo paths | SOPs, run logs, web build |
| `PORT` / `HOST` / `VOICELAB_LOG_LEVEL` | `8787` / `127.0.0.1` / — | Server (the Docker image sets `HOST=0.0.0.0` inside the container) |
| `VOICELAB_ACCESS_TOKEN`, `VOICELAB_ALLOWED_ORIGINS`, `VOICELAB_RESUME_GRACE_MS` | unset / Vite dev origins / `600000` | Shared secret for non-loopback use, extra WebSocket origins, how long a disconnected run is kept for resume |

### Proposed for the next steps in §6

These names are suggestions. Secrets go in `.env`, never in the repo.

| Variable | Purpose |
|---|---|
| `DEEPGRAM_MIP_OPT_OUT=true` | Exclude audio from Deepgram training; costs the 50% discount. Recommended on for customer data. |
| `VOICELAB_KEYTERMS_EXTRA` | Lab-specific terms (`HEK293,Opti-MEM,…`) appended to SOP-derived keyterms |
| `ELEVENLABS_PRONUNCIATION_DICT_ID` | Pronunciation dictionary for reagents and units |
| `ELEVENLABS_ZERO_RETENTION=true` | Send `enable_logging=false` (enterprise ZRM only) |
| `VOICELAB_LLM_FAST_MODE` | `speed: "fast"` experiment (beta header) |
| `VOICELAB_LLM_CACHE_TTL` | `1h` prompt-cache TTL for long bench pauses |
| `VOICELAB_STT` += `assemblyai` \| `soniox`; `ASSEMBLYAI_API_KEY`, `SONIOX_API_KEY` | Alternate STT for the eval bake-off |
| `VOICELAB_TTS` += `cartesia` \| `deepgram`; `CARTESIA_API_KEY`, `CARTESIA_VOICE_ID`, `DEEPGRAM_TTS_MODEL` | Alternate TTS |
| `OPENAI_API_KEY` | Benchmarks only; never with customer SOPs |

---

## Could not verify

- Official current list prices for Deepgram, ElevenLabs, Cartesia, Speechmatics, Azure and Inworld (vendor pages were blocked; aggregators disagree).
- Opus 5.5 time to first token at `effort: low`, and whether fast mode improves time to first token.
- ElevenLabs realtime keyterm limits, Eleven v4 Turbo pricing, and whether Scribe v2 Realtime is deprecated.
- Latency for AssemblyAI U3.5 Pro Realtime, Google Chirp 3 streaming and Azure.
- Accuracy of any vendor in lab noise. Nobody publishes it, so we have to measure it.
- Cartesia pronunciation-dictionary support and data retention terms.
- Whether Soniox offers on-prem today.
