# Discovery plan (exploratory phase)

*Status: proposed, 2026-10-07. Horizon: 7 weeks to a continue, pivot or kill decision.*

## Goals

1. Find out whether bench scientists will **actually talk to an assistant while working**, and for which jobs.
2. Measure whether the prototype is **accurate enough on lab jargon and numbers, in real lab noise**, to be trusted.
3. Find **who pays** and for what: scientist productivity, manager visibility, QA records, or the telemetry.

## Timeline

| Week | Activity | Output |
|---|---|---|
| 1–2 | 15–20 interviews, 6–8 shadowing sessions | Synthesis: top jobs, frequency, current workarounds |
| 3 | Convert 2–3 SOPs per pilot lab (Claude PDF→YAML plus human review); record a 200-utterance jargon set per lab | Pilot-ready SOPs; baseline STT eval |
| 4–5 | 2-week pilot in 2–3 labs | Run logs, metrics, diary entries |
| 6 | Exit interviews, willingness-to-pay probes, data review | Metrics deck |
| 7 | Decision meeting against the criteria below | Continue / pivot / kill memo |

## Riskiest assumptions, ranked

| # | Assumption | Why it's risky | Evidence that would kill it | Method |
|---|---|---|---|---|
| 1 | Scientists will speak to an assistant at the bench in shared labs | Social awkwardness, noise, confidentiality, "I'm faster on my own" | Under 30% of eligible runs use it in pilot week 2; interviewees describe talking as embarrassing or disruptive | Pilot usage logs, exit interviews |
| 2 | The pain is frequent: several "what's next / do the math / note this" moments per run | It may be occasional, and a printout plus a phone calculator may be good enough | Fewer than 3 such moments per run observed in shadowing | Shadowing time-motion logs |
| 3 | STT is good enough on jargon and numbers in hood or BSC noise | Numbers carry the risk; a mishearing costs trust instantly | Numeric-token error above 5% before read-back, or keyterm recall below 90% after tuning | Recorded jargon set, pilot sample audit |
| 4 | Labs will allow SOPs and audio to go to cloud vendors | IT, IP and EHS policies; works councils | 2 of 3 target labs refuse cloud processing even with ZDR/opt-outs | Ask IT/EHS during recruiting |
| 5 | SOPs can be structured cheaply | If each SOP takes days of expert time to convert, onboarding doesn't scale | More than 2 h of human review per typical SOP after Claude conversion | Time the conversion and review in week 3 |
| 6 | Real-time feedback (out-of-range flags, troubleshooting) changes outcomes | Labs may only check readings later, or not at all | No out-of-range readings logged during the pilot, or scientists ignore the flags | Pilot deviation events + interviews |
| 7 | A manager or PI will pay for it | Scientists are users; budgets sit with PIs, ops or QA | No manager names a budget line or price ≥ our floor | WTP probes, LOI ask |
| 8 | The telemetry is valuable to someone | The data story may excite founders more than buyers | Managers shown pilot dashboards can't name a decision they'd make with them | Dashboard walk-through in exit interviews |
| 9 | Latency is acceptable | Dead air after asking for a number feels broken | Perceived latency rated ≤ 3/5, or p95 above 2.5 s | Logs + post-run rating |
| 10 | Hardware works with PPE (gloves, coat, face shield, BSC) | Headsets, earbuds and laptop mics may each fail | Pilot users stop using it because of the mic or headset | Observation + interviews |

The safety catch is deliberately **not** a top-ranked value assumption. Dangerous near-misses are rare. The safety screen is a guardrail, not the product's reason to exist. Measure it, but don't sell on it.

## Interview guide (45 min)

Recruit 10–12 bench scientists (grad students to senior RAs, across academic lab, biotech and core facility) and 6–8 lab managers or PIs, plus 3–5 QA or core directors where possible. Ask for stories, not opinions. Record with consent.

### Bench scientists

1. Walk me through the last protocol you ran start to finish. Where were the SOP, your notebook and your phone?
2. When did you last lose your place in a protocol? What happened next?
3. Tell me about the last calculation you did mid-experiment. How did you do it, and how long did it take?
4. Have you ever pipetted the wrong amount because of a calculation or unit mistake? How did you find out?
5. How often do you take gloves off, or touch something you shouldn't, to check the SOP, a timer or your phone?
6. When a reading looks off (NanoDrop, cell count, pH), what do you do in the moment? Who do you ask?
7. How do you keep track of multiple timers?
8. When do you write up your notebook entry? What gets lost between doing and writing?
9. Do you talk to yourself or labmates while working? Would talking to an assistant feel normal in your lab? What would make it weird?
10. How noisy is your workspace (hood, BSC, centrifuges)? Do you wear anything on your ears?
11. If something could answer one question for you hands-free, what would it be?
12. What would make you stop trusting an assistant immediately?

### Lab managers / PIs / core directors

13. How do new people learn your protocols? How long until you trust them alone?
14. Tell me about the last experiment that failed and nobody knew why. What data would have helped?
15. How do you know whether people follow the SOP as written? Where do they deviate?
16. How complete and timely are notebook entries in your lab? What does that cost you?
17. What are your rules about recording audio, or sending protocols to cloud AI tools? Who decides?
18. What software do you pay for today (ELN, LIMS, inventory)? Who approved it, and how long did it take?
19. If you could see, for every run, step timings, deviations and questions asked, what would you do with that?
20. What would this need to do for you to pay for it, and from which budget?

## Bench shadowing protocol

- **Scope:** 6–8 sessions of 2–4 hours, at least one per persona context, covering at least 3 protocol families.
- **Consent and approvals:** written consent from the scientist; verbal notice to everyone in the room; lab manager and EHS approval for an observer (and a BSL-2 entry if required); no photos of unpublished data without permission. Check whether the institution needs an IRB determination for user research.
- **Observer setup:** stand out of the work zone; time-stamped log (spreadsheet or app); no audio recording unless everyone present consents.
- **Code each event with a timestamp:**

| Code | Event |
|---|---|
| `LOOK` | Looks away from the work to the SOP, screen or paper |
| `CALC` | Does a calculation (note the method and duration) |
| `GLOVE` | De-gloves or touches a non-sterile device |
| `TIMER` | Sets or checks a timer |
| `NOTE` | Writes or types a note (note whether it's deferred) |
| `ASK` | Asks a person a question (note what) |
| `READ` | Takes an instrument reading (note whether it's checked against a spec) |
| `ERR` / `REDO` | Error noticed, or step repeated |
| `HAZ` | Hazard-relevant moment (waste, volatile, sharps) |
| `IDLE` | Waiting (incubation, centrifuge) |

- **Debrief (15 min after):** walk through the 3 longest gaps, and ask "if you could have said one thing out loud at that moment, what would it be?"
- **Artifacts to collect (with permission):** a redacted copy of the SOP, the notebook entry written afterwards, and photos of the bench layout.
- **Output per session:** event counts per hour, the top 3 friction moments, and candidate voice utterances (which feed the STT eval set).

## Pilot design: 2 weeks, 2–3 labs

### Labs

- **A: academic molecular or cell biology lab.** Many grad students; open bench and BSC.
- **B: biotech startup** (10–50 scientists). Has an ELN; more process discipline.
- **C (optional): core facility** (genomics, protein or flow). Repetitive assays and throughput.

### Setup

- 2–4 users per lab, and **2–3 SOPs per lab** that they run at least twice a week.
- Hardware per user: a tablet or laptop at the bench, plus a choice of a close-talk headset (one ear open) or bone-conduction headset, plus a foot pedal or large PTT button. PTT is the default; hands-free is opt-in.
- Providers per [providers.md](./providers.md): Deepgram Nova-3 with SOP keyterms, Claude Opus 5.5 at low effort, ElevenLabs TTS. ZDR/opt-outs on. No raw audio retained.
- Day 1: a 30-minute onboarding with each user, and a pre-pilot baseline survey.
- Days 1–2: shadowed baseline runs *without* the tool, to time calculations and note-taking.
- Days 3–10: normal use, with a daily 2-minute diary prompt ("best and worst moment today").
- Day 9 or 10: exit interview (30 min) plus a manager dashboard walk-through.
- Support: a Slack channel; same-day fixes are allowed but logged as changes.

### Metrics

| Metric | Definition | Source | Target to continue |
|---|---|---|---|
| **Adoption** | % of eligible runs (pilot SOPs) where the assistant was used for at least 3 turns, week 2 | Run log vs lab schedule | ≥ 60% in ≥ 2 labs |
| **Turns and words per run** | Assistant-addressed turns and user words spoken per run | Run log | ≥ 15 turns/run median; rising or flat from week 1 to week 2 |
| **Time to answer, calculations** | End of user utterance → first audio of the answer | Run log | p50 < 1.5 s, p95 < 3 s, vs baseline median (shadowed) |
| **Calculation correctness** | Logged calculation results audited against an independent recompute | Audit of 100% of calculations | 100% correct; **0** model-spoken numbers that fail provenance |
| **Numeric error in record** | Wrong number in a confirmed record entry | Audit vs user review | 0 |
| **WER on lab jargon** | WER, keyterm recall and numeric-token error on ≥ 200 hand-transcribed pilot utterances per lab | Sampled audit (consented clips) | Keyterm recall ≥ 95%; numeric-token error ≤ 3% before read-back |
| **Deviations caught at the bench** | Out-of-range readings flagged live; % the user says they would otherwise have found later | Run log + interview | ≥ 1 real deviation per lab; ≥ 50% "would have found later or never" |
| **Safety screen quality** | False positives per hour; true catches | Run log, user flags | < 0.25 false positives per hour |
| **Perceived latency** | Post-run 1–5 rating; measured per-stage p50/p95 | Survey + log | Rating ≥ 4; p50 < 1.0 s with no tool call |
| **Write-up time** | Time to finish the notebook entry, with vs without the run record | Self-report + ELN timestamps | ≥ 50% reduction |
| **Sean Ellis test** | "How would you feel if you could no longer use it?" | Exit survey | ≥ 40% "very disappointed" |
| **Willingness to pay** | Manager names a price and a budget line; LOI or paid-pilot ask | Exit interview | ≥ 1 LOI or paid continuation |

All system metrics come from the event-sourced run log, so pilot instrumentation needs to be in place before day 1: stage timestamps, turn counts, calculation results, alerts, and confirmations.

## Kill / continue criteria

**Continue** (build toward a paid beta) if **all** of these hold:
- Adoption ≥ 60% of eligible runs in week 2 in at least 2 labs.
- 0 wrong numbers in confirmed records, and calculation correctness is 100%.
- ≥ 40% of users "very disappointed".
- ≥ 1 manager commits money (LOI, paid pilot or purchase request).

**Pivot** if:
- Users rely mainly on timers and notes, not guidance or math → pivot to a **hands-free capture product** (voice notes into the ELN), which is cheaper and less risky.
- Managers want the telemetry but scientists won't talk → pivot to **passive capture** (instrument data, step check-ins on a tablet) feeding execution analytics.
- STT on numbers in noise is the blocker but usage intent is high → stay put, invest 4–6 weeks in hardware and STT (headsets, keyterms, on-device VAD), then re-pilot.

**Kill** (or deprioritize hard) if:
- Adoption is below 30% in all labs **and** the stated reason is social, noise or "I don't need it" rather than a fixable bug.
- Or 2 of 3 labs block cloud processing and no customer would fund a self-hosted deployment.

## Risks to the research itself

- **Novelty effect:** week 1 usage overstates interest. Judge on week 2.
- **Friendly labs:** recruit at least one lab with no relationship to the founders.
- **Founder-led demos bias answers:** a non-founder should run the exit interviews where possible, and should ask about past behaviour, not hypotheticals.
- **Too few runs:** pick SOPs that are run at least twice a week, or the pilot will produce anecdotes, not data.
