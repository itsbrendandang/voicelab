# Vision: a voice copilot for the lab bench

*Status: exploratory, 2026-10-07. Everything here is a hypothesis until [discovery-plan.md](./discovery-plan.md) says otherwise.*

## Thesis

Bench science is **procedural work done with busy hands**. The procedure (the SOP) lives on a screen or a printout across the bench. The arithmetic lives in the scientist's head or a phone calculator. What actually happened at each step lives in memory until someone writes it up hours later.

A voice assistant that **knows the SOP, does the math deterministically, catches unsafe combinations, and records what happened as it happens** closes all three gaps at once.

The long-term asset is not the voice interface, which is commodity APIs. It is a **structured, time-stamped record of how protocols are actually executed**: which steps take longest, where readings go out of range, which questions get asked, and where runs fail. Nobody has this data today, because it never leaves the bench.

## Wedge

**SOP-grounded, calculation-safe voice guidance for high-frequency, math-heavy wet-lab protocols in biotech R&D labs and core facilities.**

- **Protocol families to start with:** cell culture passaging and seeding, qPCR/PCR master mix setup, protein quantification (BCA/Bradford), buffer and media prep, nucleic-acid extraction kits.
- **Why these:** they run weekly, involve several calculations, are done in gloves (often in a biosafety cabinet), and have measurable in-process checks (cell counts, A260/280, standard-curve R²).
- **Why not GMP first:** the validation burden (see [safety-and-compliance.md](./safety-and-compliance.md)) would consume the team before we know whether scientists will talk to the thing. GMP is the expansion, not the wedge.

## Personas

| Persona | Context | Top pains | What they'd value | Buyer? |
|---|---|---|---|---|
| **Bench scientist** (RA, grad student, postdoc) | 4–8 h/day at the bench or hood; runs 3–10 protocols a week | Losing their place in long SOPs; re-doing dilution math; de-gloving to type or check the screen; writing notes from memory afterwards | Hands-free next step and numbers; automatic notes | User, not buyer |
| **Lab manager / PI** | Runs 5–30 people; owns SOPs, training, reproducibility | New staff need supervision; inconsistent execution; "why did this fail?" post-mortems with no data; ELN entries late or thin | Consistent execution, faster onboarding, complete records, visibility into where protocols break | **Buyer (academic and small biotech)** |
| **Core facility tech** | Runs the same assays for many groups; throughput-driven | Repetitive setup math; interruptions; documenting per-customer runs | Speed, fewer errors, a run record per job | Influencer; core director buys |
| **QA / compliance** | GLP/GMP or ISO 17025 labs | Late or incomplete documentation; deviations found at review instead of at the bench; ALCOA+ gaps in hybrid paper/electronic records | Contemporaneous, attributable records; deviations flagged in real time; audit trail | **Veto holder** in regulated settings |
| **CDMO / biomanufacturing operator** | Executes batch records in cleanroom gowning | Paper or eBR entry in gowning; second-person verification; documentation errors that drive deviations | Hands-free execution with verification and e-records | Ops/QA buys; later phase |

## Top jobs to be done

1. "Tell me the next step, and only that step, without me touching anything."
2. "Do this math right and say the answer in pipettable units."
3. "Tell me if a reading is off and what that usually means."
4. "Stop me before I do something dangerous."
5. "Keep my timers while my hands are full."
6. "Write down what I just saw, with the time and the step."
7. "Produce the notebook entry so I don't have to write it tonight."
8. (Manager) "Show me where people get stuck and where runs go wrong."

## Bench scenarios

Each is a short dialogue. **A** is the assistant. `[tool]` marks a deterministic tool call; `[screen]` marks the deterministic safety screen.

**1. Dilution math with read-back**
> **Scientist:** I need ten mils of fifty millimolar Tris pH eight from the one molar stock.
> `[tool: dilution C1=1 M, C2=50 mM, V2=10 mL → V1=0.5 mL]`
> **A:** 500 microliters of 1 molar Tris into 9.5 milliliters of water. Say "confirm" to log it.
> **Scientist:** Confirm.

**2. "What's next?"**
> **Scientist:** What's next?
> **A:** Step 6 of 11: add 200 microliters of BCA working reagent to each well, then mix on the shaker for 30 seconds. Want the 30-minute 37-degree timer after that?

**3. Out-of-range reading → troubleshooting**
> **Scientist:** NanoDrop says 260/280 is 1.62, 260/230 is 1.1.
> `[log measurement → both below SOP range (1.8–2.0, >1.8) → deviation flagged]`
> **A:** Both are low and flagged. Low 260/230 usually means guanidine salt carryover from the binding buffer. The SOP's troubleshooting says to repeat wash 2 and re-elute. Do you want to log that as the corrective action?

**4. Safety catch (fires before the LLM)**
> **Scientist:** I'll just bleach the column flow-through waste.
> `[screen: bleach + guanidinium-containing waste → DANGER]`
> **A:** Stop. That flow-through contains guanidine salts. Bleach reacts with them to release toxic gas, including hydrogen cyanide from guanidine thiocyanate. Use the guanidine waste stream in your chemical hygiene plan, not bleach. *(The alert stays pinned until acknowledged.)*

**5. Timers while hands are busy**
> **Scientist:** Start thirty minutes for the incubation, and remind me at twenty-five to warm up the plate reader.
> **A:** 30-minute incubation timer started; plate-reader reminder at 25 minutes.
> *…25 min later…* **A:** Five minutes left on the incubation. Warm up the plate reader now.

**6. Hands-free observation logging**
> **Scientist:** Note: plate three, wells B4 to B6 look cloudy, possible contamination.
> **A:** Logged at 14:32 against step 4, plate 3, wells B4–B6: "cloudy, possible contamination."

**7. Cell count → seeding**
> **Scientist:** Countess says 1.4 million live per mil. I need a 24-well at fifty thousand per well in 500 microliters, with a couple extra wells' worth.
> `[tool: seeding 26 wells × 5.0e4 cells, 0.5 mL each; 1.4e6 cells/mL → 0.929 mL suspension + 12.07 mL medium]`
> **A:** For 26 wells' worth: 929 microliters of cell suspension into 12.07 milliliters of medium, 13 milliliters total, 500 microliters per well.

**8. Master mix**
> **Scientist:** SYBR master mix, 46 reactions, 20 microliters each, 5 microliters of template, primers to 400 nanomolar from 10 micromolar stocks, 10 percent extra.
> `[tool: master mix ×50.6 → 2× SYBR 506 µL; each primer 40.5 µL; water 172 µL; 15 µL/well]`
> **A:** 506 microliters SYBR, 40.5 each of forward and reverse primer, 172 microliters water. Dispense 15 per well, then 5 of template.

**9. "Not in the SOP"**
> **Scientist:** Can I swap Opti-MEM for regular DMEM here?
> **A:** The SOP doesn't cover that substitution, so I won't guess. Ask whoever owns this SOP. Want me to log the question for them?

**10. End-of-run record**
> **Scientist:** Wrap up the run.
> **A:** Draft run record ready: 11 steps, 2 h 47 min; 3 calculations with inputs; 1 deviation (low 260/230, corrective action logged); 2 observations; 1 safety alert acknowledged. It's in your ELN as a draft for you to review and sign.

## Why voice

- **Gloves and contamination.** Touching a keyboard or phone means de-gloving or contaminating the device, and touching a device in a biosafety cabinet breaks aseptic technique.
- **Eyes on the sample.** Looking away mid-pipetting is how wells get skipped. Voice keeps the eyes on the plate.
- **Contemporaneous by default.** ALCOA+ asks for records made *at the time*. Speaking a note costs 3 seconds; typing it later costs accuracy.
- **Reading is slow at arm's length.** SOPs are dense. Hearing "Step 6: 200 microliters, then shake 30 seconds" is faster than finding your place on a page.
- **Limits to be honest about:** shared, noisy labs; social awkwardness; and confidentiality of spoken content. These are the riskiest assumptions in discovery.

## The data asset: process-execution telemetry

Every run produces an event-sourced log, which nobody captures today:

| Signal | Example | Who it's valuable to |
|---|---|---|
| Step timings | Step 4 takes 3× longer for new staff | Lab manager (training), ops (scheduling) |
| Deviations vs spec | 260/230 out of range in 30% of runs by one user | PI, QA |
| Questions per step | Step 7 generates most questions → the SOP text is unclear | SOP owner |
| Calculations, with inputs | Stock concentration differs from what the SOP assumes | Reproducibility, QA |
| Safety triggers | Bleach near guanidine waste, 2×/month | EHS / chemical hygiene officer |
| Interruptions and timer overruns | Incubations routinely run 8 min long | Reproducibility |
| Outcomes, linked later | Run → assay result → pass/fail | Root cause of failed experiments |

**How it compounds:**

1. **Per lab:** SOPs get rewritten where people stumble, onboarding gets faster, and "why did this fail?" has an answer, which ties directly to reproducibility. Over 70% of surveyed researchers report failing to reproduce another scientist's experiment ([Baker, *Nature* 2016](https://www.nature.com/articles/533452a)). An estimated ~$28B/yr of US preclinical research is not reproducible ([Freedman et al., *PLoS Biol* 2015](https://journals.plos.org/plosbiology/article?id=10.1371/journal.pbio.1002165)).
2. **Per protocol, across labs:** with explicit consent and aggregation, the same kit protocol run in 50 labs shows where it fails. Kit vendors and core facilities would value that.
3. **For the product:** better keyterms, troubleshooting trees learned from real deviations, and predicted failure points ("runs with incubation over 35 min have low yield").

**Caveats:** the data is owned by the customer. Aggregate use needs contractual rights from day one, and the moat only exists at scale. Do not build features that depend on cross-lab data until single-lab value is proven.

## Competitive landscape

| Company | What they do | Voice at the bench? | Gap relative to us |
|---|---|---|---|
| **LabTwin → Labforward** | Voice lab assistant (ex-Sartorius) merged into Labforward Sept 2024 ([announcement](https://www.chemeurope.com/en/news/1184458/expanded-possibilities-for-laboratory-digitalization-and-connectivity.html)). **Labfolder Go** (Apr 2025) adds voice notes, voice-tagged photos, timers and e-signatures to their ELN ([press](https://labforward.io/blog/labfolder-go-app-press-release)). An aggregator reports LabTwin was discontinued in July 2026 ⚠ ([bouncewatch](https://bouncewatch.com/company/labtwin)) | Yes (dictation-first) | Capture-focused, tied to its own ELN; no evidence of deterministic calculations, live SOP state or safety screening |
| **LabVoice** | Voice assistant for data capture and SOP guidance; Dotmatics ELN integration since 2020 ([Lab Manager](https://www.labmanager.com/enabling-voice-assisted-laboratory-workflows-24330)). PitchBook lists a $1.2M round in Jun 2026 ⚠ | Yes | Small; little public evidence of an LLM-era product or Part 11 validation |
| **Benchling AI** | Launched Oct 2025: Compose Agent (preview), Deep Research, Data Entry Agent, Notebook Check; credit-based ([Benchling](https://www.benchling.com/blog/introducing-benchling-ai)) | No | Desk-side; documents *after* the bench. Benchling is an integration target and a likely fast follower |
| **Sapio Sciences (ELaiN)** | Natural-language assistant over Sapio LIMS/ELN, "text or voice"; GA after a Nov 2023 beta ([SelectScience](https://www.selectscience.net/article/sapio-sciences-advances-its-ai-powered-lab-assistant)) | Nominal | Operates the LIMS rather than guiding hands; only for Sapio customers |
| **Elemental Machines** | Lab sensors and monitoring; launched an agentic AI platform for equipment risk and energy in Jan 2026 ([BusinessWire](https://www.businesswire.com/news/home/20260108767432/en/Elemental-Machines-Introduces-Its-Next-Evolution-With-the-Launch-of-New-Agentic-AI-Platform)) | No | Watches equipment, not people or protocols. Partner for instrument context |
| **Artificial, Inc.** | Lab orchestration and scheduling for automated labs ([arXiv](https://arxiv.org/abs/2504.00986v1)) | No | Targets automated workcells; we target human hands |
| **Opentrons (OpentronsAI)** | Generates robot protocols from chat and forms; warns users to review output ([docs](https://docs.opentrons.com/flex/protocols/opentrons-ai/)) | No voice found | Robot side; complementary (voice → reviewed protocol → robot is a later integration) |
| **Dimenso** | Smart glasses, computer vision and voice for documentation and protocol tracking; raised $650k in Sept 2026 ([GlobeNewswire](https://www.globenewswire.com/news-release/2026/09/15/3362083/0/en/dimenso-raises-650-000-to-bring-physical-AI-and-smart-glasses-to-life-sciences-laboratories.html)) | Yes, plus vision | Closest new entrant; hardware-heavy, pre-seed |
| **LabOS** (Stanford/Princeton, NVIDIA) | AR goggles plus a vision-language model that compares actions with protocols ([Sci Am](https://www.scientificamerican.com/article/how-labos-ai-powered-smart-goggles-could-reduce-human-error-in-science/)) | Yes, plus vision | Research system; proves the direction and the team will spin out or partner |
| **Tulip** | Frontline operations platform; Frontline Copilot grounded in plant documents; composable AI agents (Oct 2025); $120M Series D at $1.3B ([Tulip](https://tulip.co/press/tulip-unveils-composable-ai-agents-at-operations-calling/)) | Mostly chat | Strong in manufacturing; weak at research benches. Integration partner or competitor at expansion |
| **Augmentir** | Connected-worker platform with the "Augie" copilot ([Augmentir](https://www.augmentir.com/?p=14647)) | No voice evidence | Manufacturing-only |
| **Apprentice.io (Tempo)** | Agentic pharma MES/LES with wearables, AR and voice tags; human-in-the-loop GMP decisions ([Tech-Clarity](https://tech-clarity.com/pharma-mes-agentic-ai/22655)) | Partial | The incumbent we'd meet in GMP; validated, but MES-centric |
| **Platform risk** | Samsung/Google AI glasses shipping in 2026 ([Tempo.co](https://en.tempo.co/read/2120958/samsung-to-launch-ai-powered-smart-glasses-in-november-2026)) | — | Generic assistants will "read the SOP". Our defence is deterministic calculations, safety, SOP state, and records that hold up to QA |

**The gap:** nobody combines voice-first interaction, live SOP state, deterministic calculations, a deterministic safety screen, and an execution-telemetry record. The incumbents are either ELN/LIMS vendors bolting on chat, or manufacturing platforms.

## Expansion path to manufacturing

| Area | Research lab (now) | GMP manufacturing (later) | What changes technically |
|---|---|---|---|
| Records | Draft ELN entry; scientist signs | Executed batch record (eBR) is the legal record | Part 11 / Annex 11: audit trail, e-signatures, validation, change control |
| Workflow | LLM navigates the SOP | Deterministic state machine; LLM advisory only | The EU's draft GMP Annex 22 reportedly excludes generative AI from critical GMP use ([summary](https://www.scilife.io/blog/what-annex-22-means-for-ai-governance-in-gmp-regulated-environments)) |
| Verification | Read-back confirm | Second-person verification, ID'd operators | Badge or SSO identity (not voiceprint), dual sign-off |
| Integration | ELN (Benchling, Labguru, LabArchives) | MES/eBR (Tempo, Tulip, PAS-X, Syncade, Opcenter), ERP, LIMS | ISA-95 models, OPC UA, MES APIs |
| Environment | Lab, ~60–70 dBA | Cleanroom gowning, plant noise, sometimes hazardous areas | Headsets that work under hoods and gowning; ruggedized or intrinsically safe hardware; on-prem or edge deployment |
| Robotics / cobots | — | Voice-initiated robot tasks | Voice → intent → *proposed* action → explicit confirmation gate → robot controller runs a **pre-validated program**. Never speech directly to motion; robot safety stays in rated hardware (ISO 10218, ISO/TS 15066) |
| Language | English | Multilingual workforce | Multilingual STT/TTS; SOP translation under change control |

## Business model hypotheses (to test, not to assume)

| # | Hypothesis | Who pays | Test in discovery |
|---|---|---|---|
| H1 | Per-seat SaaS for active bench users | Lab manager / PI (biotech) | Willingness to pay at 3 price points during pilot exit interviews |
| H2 | Site licence plus SOP-conversion onboarding fee for core facilities | Core director | Core facility pilot: volume of SOPs and time saved per job |
| H3 | GxP tier: validated release, VPC/on-prem, validation package, priced per site | QA/ops at CDMOs | 3–5 QA interviews: is "contemporaneous voice records" worth a validation project? |
| H4 | Execution analytics for lab ops/QA (dashboards over telemetry) | Lab ops / QA | Show pilot dashboards; ask "what would you pay to keep this?" |
| H5 | "Voice-ready protocol" partnerships with kit vendors | Kit vendors | 2 conversations; *only* after consented data exists |

**Unit cost sanity check** (provider list prices, see [providers.md](./providers.md)): a 3-hour run with ~60 assistant turns costs roughly $1–3. The breakdown is about $0.70 of Claude tokens with a cached SOP prefix, about $0.45 of TTS, and up to about $1.40 of STT if streamed continuously. On-device VAD gating cuts the STT share sharply. Gross margin is not the risk; adoption is.

## What would make this wrong

- Scientists won't talk out loud in shared labs (social norms, noise, confidentiality).
- The math and "what's next" pain is real but occasional, and a laminated card plus a phone calculator is good enough.
- STT error on numbers and units in hood noise is too high to trust without a screen, which kills the hands-free value.
- Labs won't send SOPs and audio to cloud vendors, and self-hosting is too expensive this early.
- Benchling or Tulip ships "good enough" voice inside the system of record before we have a reason to exist alongside it.
