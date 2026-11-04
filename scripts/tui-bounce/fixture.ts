/**
 * Markdown answer streamed through the real transcript.
 * Long enough to overflow both 80x24 and 110x40 after scrollbox padding.
 * Includes a heading, a 3-column table, bold bullets, a fenced block,
 * and a numbered list. Word and chunk splitters keep the source identical.
 */

export const STREAM_MARKDOWN = [
  "# Why the sky colour changes",
  "",
  "Sunlight is scattered by air. The short wavelengths leave the beam first, so a clear overhead sky is blue while the direct beam turns yellow.",
  "",
  "## Measurements",
  "",
  "The pattern is obvious in physical optics once the wavelength term is written out. A longer path through the atmosphere removes still more of the blue.",
  "",
  "| Band | Wavelength | Effect |",
  "| --- | --- | --- |",
  "| Blue | 450 nm | Strong scatter |",
  "| Green | 530 nm | Medium scatter |",
  "| Red | 650 nm | Weak scatter |",
  "",
  "- **Rayleigh** scattering dominates the daytime sky",
  "- **Plateau of** extinction appears near the horizon",
  "- **Mie** scattering whitens the haze around the sun",
  "- **Ozone** cuts a dark band in the sunset spectrum",
  "",
  "1. Measure the spectrum at noon with the sun high.",
  "2. Repeat the same pointing at sunset.",
  "3. Compare the ratio of blue to red along the path.",
  "4. Write the ratio next to the airmass.",
  "",
  "```ts",
  "export function rayleigh(lambdaNm: number): number {",
  "  const lambda = lambdaNm / 550;",
  "  return 1 / Math.pow(lambda, 4);",
  "}",
  "```",
  "",
  "## Reading the trace",
  "",
  "Keep the viewport pinned to the newest line while the paragraph is still growing. Wrapping must not move the lines above it.",
  "",
  ...Array.from({ length: 6 }, (_, index) => {
    const n = index + 1;
    return [
      `### Note ${n}`,
      "",
      `Note ${n} stays on the same topic. The eye reports colour when the path length changes, and the transcript keeps every sentence so the scroll range is real. Sentence two adds the wavelength, the airmass, and the instrument noise. Sentence three says the fit is obvious in physical units, not in a rescaled chart.`,
      "",
    ].join("\n");
  }),
  "The last line of the answer is this one.",
].join("\n");

/** Whitespace-delimited tokens, whitespace kept as its own deltas. */
export function wordDeltas(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [text];
}

/** Fixed-width slices, so a slice can split a marker or a table row. */
export function chunkDeltas(text: string, size = 24): string[] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
