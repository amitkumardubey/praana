/**
 * Print scroll-bounce metrics for the transcript harness.
 *
 *   bun --preload ./tests/helpers/solid-client.ts scripts/tui-bounce/run.ts
 *   bun --preload ./tests/helpers/solid-client.ts scripts/tui-bounce/run.ts \
 *     --width 80 --height 24 --batch 0 --deltas words --max-deltas 40
 */
import { BOUNCE_MATRIX, formatBounceReport, runBounceMatrix, type BounceScenario } from "./harness.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${name}`);
  return value;
}

function numberOption(name: string): number | undefined {
  const value = option(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${name}`);
  return parsed;
}

const width = numberOption("--width");
const height = numberOption("--height");
const batch = numberOption("--batch");
const deltas = option("--deltas");
const maxDeltas = numberOption("--max-deltas");
const arrival = numberOption("--arrival");

if (deltas !== undefined && deltas !== "words" && deltas !== "chunks") {
  throw new Error("--deltas must be words or chunks");
}

const selected: BounceScenario[] =
  width === undefined && height === undefined && batch === undefined && deltas === undefined
    ? BOUNCE_MATRIX.map((scenario) => ({ ...scenario, maxDeltas }))
    : [
        {
          width: width ?? 80,
          height: height ?? 24,
          batchMs: batch ?? 0,
          deltas: deltas ?? "words",
          arrivalMs: arrival ?? (batch === 33 ? 10 : 0),
          maxDeltas,
        },
      ];

const started = Date.now();
const reports = await runBounceMatrix(selected);
for (const report of reports) {
  console.log(formatBounceReport(report));
  console.log(`final-lines ${report.finalText.split("\n").length}`);
  console.log("---");
}
console.log(`elapsed-ms ${Date.now() - started}`);
