import { describe, expect, it } from "vitest";
import { PlaybackQueue } from "./playbackQueue";

const LEAD = { startLead: 0.08, underrunLead: 0.03 };

/** Stream `n` chunks of `dur` seconds for the current job, all at clock time `now` (faster than real time). */
function stream(q: PlaybackQueue, n: number, dur: number, now: number) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = q.schedule(dur, now);
    if (c) out.push(c);
  }
  return out;
}

describe("PlaybackQueue: gapless continuation across jobs", () => {
  it("a new tts.start queues after audio still playing instead of cutting it off", () => {
    const q = new PlaybackQueue(LEAD);
    // Urgent alert synthesised in 0.5 s but 5 s long; tts.end arrives long before playback ends.
    expect(q.begin("alert-1", "urgent")).toEqual([]);
    const alert = stream(q, 5, 1, 10);
    q.end("alert-1");
    expect(alert[0]?.start).toBeCloseTo(10.08);
    expect(alert.at(-1)?.end).toBeCloseTo(15.08);
    // Claude's reply starts 1.5 s later: nothing is dropped, it continues right after the alert.
    expect(q.begin("t1", "normal")).toEqual([]);
    const reply = stream(q, 2, 1, 11.5);
    expect(reply[0]?.start).toBeCloseTo(15.08);
    expect(reply[1]?.start).toBeCloseTo(16.08);
    expect(q.liveChunks).toBe(7);
  });

  it("uses the start lead after silence and the shorter lead on an underrun", () => {
    const q = new PlaybackQueue(LEAD);
    q.begin("t1", "normal");
    expect(q.schedule(0.5, 2)?.start).toBeCloseTo(2.08);
    // Next chunk arrives late (clock already past the cursor): re-anchor with the underrun lead.
    expect(q.schedule(0.5, 3)?.start).toBeCloseTo(3.03);
    q.end("t1");
    // A job that starts after everything drained gets the start lead again.
    q.begin("t2", "normal");
    expect(q.schedule(0.5, 9)?.start).toBeCloseTo(9.08);
  });

  it("only the job announced by the latest tts.start receives frames", () => {
    const q = new PlaybackQueue(LEAD);
    expect(q.schedule(1, 0)).toBeNull(); // no tts.start yet
    q.begin("t1", "normal");
    q.end("t1");
    expect(q.schedule(1, 0)).toBeNull(); // after tts.end
    q.begin("t2", "normal");
    q.detach(); // ignored turn / dropped connection
    expect(q.accepting).toBe(false);
    expect(q.schedule(1, 0)).toBeNull();
  });
});

describe("PlaybackQueue: priorities", () => {
  it("barge-in drops normal speech but keeps urgent speech, and later audio follows the urgent audio", () => {
    const q = new PlaybackQueue(LEAD);
    q.begin("alert-1", "urgent");
    const alert = stream(q, 3, 1, 0);
    q.end("alert-1");
    q.begin("t1", "normal");
    const reply = stream(q, 3, 1, 0.5);
    const dropped = q.dropNormal();
    expect(dropped.map((c) => c.id).sort()).toEqual(reply.map((c) => c.id).sort());
    expect(q.liveChunks).toBe(alert.length);
    expect(q.accepting).toBe(false); // the rest of the interrupted reply is ignored
    expect(q.schedule(1, 0.6)).toBeNull();
    // The next reply continues right after the alert, not after the dropped audio.
    q.begin("t2", "normal");
    expect(q.schedule(1, 0.7)?.start).toBeCloseTo(alert.at(-1)!.end);
  });

  it("barge-in while urgent audio is still streaming keeps accepting its frames", () => {
    const q = new PlaybackQueue(LEAD);
    q.begin("alert-1", "urgent");
    stream(q, 1, 1, 0);
    expect(q.dropNormal()).toEqual([]);
    expect(q.accepting).toBe(true);
    expect(q.schedule(1, 0.2)).not.toBeNull();
  });

  it("an urgent job pre-empts queued normal audio but never earlier urgent audio", () => {
    const q = new PlaybackQueue(LEAD);
    q.begin("alert-1", "urgent");
    const first = stream(q, 2, 1, 0);
    q.end("alert-1");
    q.begin("t1", "normal");
    const chatter = stream(q, 4, 1, 0.1);
    q.end("t1");
    const dropped = q.begin("alert-2", "urgent");
    expect(dropped.map((c) => c.id).sort()).toEqual(chatter.map((c) => c.id).sort());
    // Second alert follows the first one gaplessly.
    expect(q.schedule(1, 0.2)?.start).toBeCloseTo(first.at(-1)!.end);
  });

  it("an urgent job interrupting normal speech starts promptly", () => {
    const q = new PlaybackQueue(LEAD);
    q.begin("t1", "normal");
    stream(q, 10, 1, 0); // 10 s of buffered reply
    q.end("t1");
    expect(q.begin("alert-1", "urgent")).toHaveLength(10);
    expect(q.schedule(1, 1)?.start).toBeCloseTo(1.08);
  });

  it("explicit Stop drops everything; urgent audio arriving later still plays", () => {
    const q = new PlaybackQueue(LEAD);
    q.begin("alert-1", "urgent");
    stream(q, 2, 1, 0);
    q.end("alert-1");
    q.begin("t1", "normal");
    stream(q, 2, 1, 0);
    expect(q.dropAll()).toHaveLength(4);
    expect(q.liveChunks).toBe(0);
    expect(q.voiceAt(0.5)).toBe("silent");
    q.begin("alert-2", "urgent");
    expect(q.schedule(1, 0.5)?.start).toBeCloseTo(0.58);
  });

  it("an interrupted assistant turn drops only that turn's normal audio", () => {
    const q = new PlaybackQueue(LEAD);
    q.begin("sys-1", "normal");
    const sys = stream(q, 1, 1, 0);
    q.end("sys-1");
    q.begin("t1", "normal");
    const t1 = stream(q, 2, 1, 0);
    expect(q.dropTurn("t1").map((c) => c.id).sort()).toEqual(t1.map((c) => c.id).sort());
    expect(q.liveChunks).toBe(sys.length);
    // An urgent job with the same turn id is never dropped this way.
    q.begin("t1", "urgent");
    stream(q, 1, 1, 0);
    expect(q.dropTurn("t1")).toEqual([]);
  });
});

describe("PlaybackQueue: barge-in classification", () => {
  it("protects urgent audio, arms barge-in on normal audio, and is silent when drained", () => {
    const q = new PlaybackQueue(LEAD);
    expect(q.voiceAt(0)).toBe("silent");
    q.begin("alert-1", "urgent");
    const alert = stream(q, 2, 1, 0); // 0.08 .. 2.08
    q.end("alert-1");
    q.begin("t1", "normal");
    const reply = stream(q, 2, 1, 0); // 2.08 .. 4.08
    q.end("t1");
    expect(q.voiceAt(0)).toBe("protected"); // urgent about to start (inside the lookahead)
    expect(q.voiceAt(1)).toBe("protected");
    expect(q.voiceAt(2.5)).toBe("interruptible");
    for (const c of [...alert, ...reply]) q.chunkEnded(c.id);
    expect(q.voiceAt(5)).toBe("silent");
  });

  it("an urgent-only stream waiting for its next chunk stays protected", () => {
    const q = new PlaybackQueue(LEAD);
    q.begin("alert-1", "urgent");
    const [c] = stream(q, 1, 1, 0);
    q.chunkEnded(c!.id);
    expect(q.voiceAt(3)).toBe("protected");
    q.end("alert-1");
    expect(q.voiceAt(3)).toBe("silent");
  });
});
