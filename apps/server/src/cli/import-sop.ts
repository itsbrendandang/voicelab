/**
 * Convert an unstructured SOP (txt / md / pdf) into voicelab SOP YAML using
 * Claude structured outputs, then validate it with `parseSop`.
 *
 *   npm run sop:import -w @voicelab/server -- <file.(txt|md|pdf)> [--out sops/] [--id my-sop] [--effort high]
 *
 * Valid output is written to <out>/<id>.yaml. Output that fails validation is
 * written to <out>/<id>.yaml.draft (not picked up by the server) with the
 * issues listed, so a human can fix it.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { parseSop, SopSchema, SopValidationError } from "@voicelab/core";
import { EFFORTS, loadConfig, type Effort } from "../config";
import { DEFAULT_SOP_DIR } from "../paths";
import { FALLBACK_BETA } from "../agent/claude";
import { toYaml, yamlComment } from "./yaml";

export const ImportSchema = z.object({
  sop: SopSchema,
  review: z
    .array(
      z.object({
        path: z.string().describe('Where the gap is, e.g. "steps[3].measurements" or "reagents.tris.molecularWeight"'),
        note: z.string().describe("What is missing or ambiguous in the source"),
      }),
    )
    .describe("Every gap, ambiguity or judgment call a human reviewer must check"),
});
export type ImportResult = z.infer<typeof ImportSchema>;

export const IMPORT_SYSTEM = `You convert laboratory standard operating procedures into structured JSON for a voice assistant that guides scientists at the bench. The structured fields drive real-time checks: spoken readings are compared against measurement ranges, reagent mentions trigger hazard warnings, and step timers are started automatically. A wrong value is worse than a missing one.

Rules
- Extract only what the source states. Never invent or "typical-value" fill expected ranges, targets, concentrations, volumes, durations, temperatures, molecular weights, storage conditions or GHS hazard codes. When the source lacks something the schema has a field for, omit the field and add a review entry.
- Keep each step's instruction faithful to the source; light cleanup of formatting is fine. Write \`spoken\` as a short paraphrase (25 words or fewer) for text-to-speech that keeps every number and unit exactly as in the instruction.
- One step per numbered or clearly separate action in the source, in order. Step ids are s1, s2, ...; reagent and measurement ids are short kebab-case.
- Mark \`critical: true\` only when the source flags the step (critical, caution, warning, must, do not) or the action is irreversible or safety-relevant; say why in a review entry.
- Add a \`timer\` only when the step states a fixed duration (for example "incubate 5 min"); for a range like "5–10 min" use the lower bound and add a review entry.
- Add \`measurements\` only for readings the operator takes, with min/max/target exactly as the source gives them, in the source's units, and \`outOfRangeHint\` only if the source says what an out-of-range value means.
- Add GHS H-codes to a reagent only when the source lists them. Hazards described in words go in the reagent's notes and get a review entry.
- Put troubleshooting entries only where the source has a troubleshooting section or explicit if/then guidance.
- The SOP id is a kebab-case slug of the title. Use the document's version if stated, else "1.0".
- In \`review\`, list every gap, ambiguity, assumption and judgment call. This list is shown to the human reviewer as comments in the YAML.`;

function usage(): never {
  console.error("usage: npm run sop:import -w @voicelab/server -- <file.(txt|md|pdf)> [--out <dir>] [--id <sop-id>] [--effort low|medium|high|xhigh|max] [--model <model>]");
  process.exit(2);
}

async function buildUserContent(file: string): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
  const ext = extname(file).toLowerCase();
  const name = basename(file);
  if (ext === ".pdf") {
    const data = (await readFile(file)).toString("base64");
    return [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data }, title: name },
      { type: "text", text: `Convert this SOP (${name}) into the structured format.` },
    ];
  }
  if (ext !== ".txt" && ext !== ".md" && ext !== ".markdown") {
    throw new Error(`Unsupported file type "${ext}" (use .txt, .md or .pdf)`);
  }
  const text = await readFile(file, "utf8");
  if (!text.trim()) throw new Error(`${name} is empty`);
  return [
    {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: text },
      title: name,
    },
    { type: "text", text: `Convert this SOP (${name}) into the structured format.` },
  ];
}

export function renderImportedYaml(result: ImportResult, meta: { source: string; model: string; issues: string[] }): string {
  const header = [
    `Imported from ${meta.source} by sop:import on ${new Date().toISOString().slice(0, 10)} (${meta.model}).`,
    "Machine-extracted: check every value against the source before using it at the bench.",
  ];
  const review = result.review.map((r) => `REVIEW ${r.path}: ${r.note}`);
  const issues = meta.issues.map((i) => `INVALID: ${i}`);
  const comments = yamlComment([...header, ...(review.length ? ["", ...review] : []), ...(issues.length ? ["", ...issues] : [])].join("\n"));
  return `${comments}\n\n${toYaml(result.sop)}`;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      id: { type: "string" },
      effort: { type: "string" },
      model: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || positionals.length !== 1) usage();
  const file = resolve(process.env.INIT_CWD ?? process.cwd(), positionals[0]!);
  const outDir = values.out ? resolve(process.env.INIT_CWD ?? process.cwd(), values.out) : DEFAULT_SOP_DIR;
  const effort = (values.effort ?? "high") as Effort;
  if (!EFFORTS.includes(effort)) usage();

  const config = loadConfig();
  if (config.llm.provider !== "anthropic") {
    console.error("sop:import needs Claude: set ANTHROPIC_API_KEY in .env (the offline agent cannot read documents).");
    process.exit(1);
  }
  const model = values.model ?? config.llm.model;
  const client = new Anthropic({ ...(config.llm.apiKey ? { apiKey: config.llm.apiKey } : {}), maxRetries: 2 });

  console.error(`Reading ${file} ...`);
  const content = await buildUserContent(file);
  console.error(`Extracting with ${model} (effort ${effort}) ...`);

  let message: Anthropic.Beta.BetaMessage;
  try {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 64000,
      system: IMPORT_SYSTEM,
      messages: [{ role: "user", content }],
      output_config: { effort, format: zodOutputFormat(ImportSchema) },
      fallbacks: "default",
      betas: [FALLBACK_BETA],
    });
    message = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) console.error("Anthropic rejected the API key.");
    else if (err instanceof Anthropic.RateLimitError) console.error("Rate limited by the Anthropic API; try again shortly.");
    else if (err instanceof Anthropic.BadRequestError) console.error(`Request rejected: ${err.message}`);
    else if (err instanceof Anthropic.APIError) console.error(`Anthropic API error ${err.status ?? ""}: ${err.message}`);
    else console.error(`Failed: ${(err as Error).message}`);
    process.exit(1);
  }

  if (message.stop_reason === "refusal") {
    console.error(`The model declined this document (${message.stop_details?.category ?? "no category"}).`);
    process.exit(1);
  }
  if (message.stop_reason === "max_tokens") {
    console.error("Output was truncated (max_tokens). Split the document and import the parts separately.");
    process.exit(1);
  }
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let result: ImportResult;
  try {
    result = ImportSchema.parse(JSON.parse(text));
  } catch (err) {
    console.error(`Could not parse the structured output: ${(err as Error).message}`);
    process.exit(1);
  }
  if (values.id) result.sop.id = values.id;

  // Validate exactly what will be written (YAML -> parseSop, including cross-checks).
  let issues: string[] = [];
  const body = toYaml(result.sop);
  try {
    parseSop(body, `${result.sop.id}.yaml`);
  } catch (err) {
    issues = err instanceof SopValidationError ? err.issues : [(err as Error).message];
  }

  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `${result.sop.id}.yaml${issues.length ? ".draft" : ""}`);
  await writeFile(outFile, renderImportedYaml(result, { source: basename(file), model: message.model, issues }), "utf8");

  console.log(`Wrote ${outFile}`);
  console.log(`  ${result.sop.steps.length} steps, ${result.sop.reagents.length} reagents, ${result.sop.steps.reduce((n, s) => n + s.measurements.length, 0)} measurement specs`);
  if (result.review.length) {
    console.log(`  ${result.review.length} item(s) need human review:`);
    for (const r of result.review) console.log(`   - ${r.path}: ${r.note}`);
  }
  if (issues.length) {
    console.log(`  Validation FAILED (${issues.length} issue(s)); saved as a .draft the server will not load:`);
    for (const i of issues) console.log(`   - ${i}`);
    process.exitCode = 1;
  } else {
    console.log("  Validation passed. Review the flagged items, then restart the server to load it.");
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]).replace(/\.[cm]?[jt]s$/, "") === resolve(new URL(import.meta.url).pathname).replace(/\.[cm]?[jt]s$/, "");
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
