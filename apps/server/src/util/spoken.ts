/** Helpers for interpreting spoken numbers and durations (input side only). */

const SMALL: Record<string, number> = {
  zero: 0, oh: 0, one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/**
 * Replace simple English number words with digits: "five minutes" -> "5 minutes",
 * "twenty five" -> "25", "a hundred" -> "100", "half an hour" -> "30 minutes".
 * Leaves "a"/"an" alone unless directly followed by a time unit.
 */
export function replaceNumberWords(text: string): string {
  let t = text.replace(/\bhalf an? hour\b/gi, "30 minutes").replace(/\b(a|an) (hour|minute|second)\b/gi, "1 $2");
  t = t.replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-](one|two|three|four|five|six|seven|eight|nine)\b/gi, (_m, a: string, b: string) => String(TENS[a.toLowerCase()]! + SMALL[b.toLowerCase()]!));
  t = t.replace(/\b(one|two|three|four|five|six|seven|eight|nine|a)?\s?hundred\b/gi, (_m, a?: string) => String((a ? SMALL[a.toLowerCase()] ?? 1 : 1) * 100));
  t = t.replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi, (m) => String(TENS[m.toLowerCase()]));
  t = t.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/gi, (m) => String(SMALL[m.toLowerCase()]));
  // "0 point 4 5" -> "0.45"
  t = t.replace(/\b(\d+) point ((?:\d\s?)+)\b/gi, (_m, a: string, b: string) => `${a}.${b.replace(/\s/g, "")}`);
  t = t.replace(/\bpoint ((?:\d\s?)+)\b/gi, (_m, b: string) => `0.${b.replace(/\s/g, "")}`);
  return t;
}

const UNIT_SECONDS: [RegExp, number][] = [
  [/^(h|hr|hrs|hour|hours)$/i, 3600],
  [/^(m|min|mins|minute|minutes)$/i, 60],
  [/^(s|sec|secs|second|seconds)$/i, 1],
];

/** "5 min", "1 h 30 min", "90 s", "1:30" (m:ss), "2 hours and 15 minutes" -> seconds. Undefined if unparseable. */
export function parseDuration(input: string): number | undefined {
  const text = replaceNumberWords(input.trim().toLowerCase());
  const clock = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (clock) {
    const [a, b, c] = [Number(clock[1]), Number(clock[2]), clock[3] === undefined ? undefined : Number(clock[3])];
    return c === undefined ? a * 60 + b : a * 3600 + b * 60 + c;
  }
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const unit = UNIT_SECONDS.find(([r]) => r.test(m![2]!));
    if (!unit) continue;
    total += Number(m[1]) * unit[1];
    matched = true;
  }
  if (!matched && /^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text)); // bare number = seconds
  return matched && total > 0 ? Math.round(total) : undefined;
}

// Spoken/compact duration formatting and timer countdowns live in @voicelab/core
// (`speakDuration`, `formatDuration`, `timerRemaining`); only parsing is server-side.
