# Streaming TUI probe

Capture repeated tmux pane states while a deterministic mock streams markdown, then analyze the transcript for visual instability. This is a diagnostic, not a verdict: inspect flagged samples.

## Capture and replay

With Bun, tmux and the target worktree's dependencies installed, in separate terminals:

```sh
bun scripts/tui-probe/mock-llm.ts --port 9779 --delay-ms 12
bun scripts/tui-probe/capture.ts --worktree /path/to/praana --label build-a --size 110x40
```

The driver writes JSONL in `~/.cache/probe-scratch/`, with a header containing the label, size, commit, and achieved Hz. Analyze it (height must match the capture):

```sh
bun -e 'import { analyzeSamples, readSamples } from "./scripts/tui-probe/analyze"; const r = analyzeSamples(await readSamples(process.argv[1]), {height: 40}); console.log(JSON.stringify(r, null, 2));' ~/.cache/probe-scratch/build-a-1.jsonl
```

## Metrics

Fixture source line numbers are one-based; blank/fence lines occupy numbers. Chrome and decoration are excluded. Matching strips ANSI and markdown markers, and accepts fragments of at least 12 characters of fixture lines, including wrapped continuations. Ambiguous or incomplete fragments may be unmatched or misidentified. `unmatchedRatio` is unmatched nonblank, non-decoration candidate rows divided by all such rows, across samples.

- `firstVisible`/`lastVisible`: first/last matched fixture lines in each viewport, or null.
- `regressions`: samples whose last line is below the greatest previous last line.
- `scrollReversals`: matched samples whose first line decreases from the previous matched sample while the last does not decrease.
- `aba`: middle frames where transcript viewport text differs from both neighbors and the neighbors match exactly; status/footer are excluded.
- `styleFlips`: identical visible line text changing marker or first text-cell bold, dim or color from the preceding sample, then returning within three samples. Counts are per line and transition.
- Summary includes elapsed milliseconds, interval-based achieved Hz, distinct transcript screens, and the first ten zero-based offending indices with up to three transcript lines each. The `finished` helper checks for the prompt without an active status; unlike the capture driver's `turnFinished`, it does not require a previously observed busy state.

## Limits

Tmux samples emulated screen states, not Windows Terminal. It only sees glitches that reach the terminal as separate states; faster or between-sample glitches are invisible. Sampling is unthrottled and its achieved rate depends on the machine and tmux overhead. Partially rendered markdown, duplicate fixture text, wrapping, and a status disappearing before the prompt is ready can affect interpretation.

## A/B, noise and checks

The runner starts its own mock on port 9779, captures A and B in interleaved order, and retains captures and reports under `~/.cache/probe-scratch/ab/` by default. It retries captures below 60 Hz twice and records batch load averages. Supply `--out` to choose a directory, `--runs` (default 5), `--delay-ms` (default 12), and repeat `--size` for multiple batches.

```sh
bun scripts/tui-probe/run-ab.ts --a /path/to/a --b /path/to/b --label-a old --label-b new --runs 5 --size 110x40 --size 80x24
bun scripts/tui-probe/run-ab.ts --noise /path/to/a --runs 5 --size 110x40
bun scripts/tui-probe/run-ab.ts --a /path/to/a --b /path/to/b --check --regressions 0 --scrollReversals 0 --aba 0 --styleFlips 20
```

The table shows mean/min/max counts and the mean of per-run rates per 1,000 samples. `--check` checks B (or the noise build): the first three thresholds apply to the maximum count across runs and default to zero; `--styleFlips` applies to the mean rate per 1,000 samples and is off unless specified. This diagnostic is not a substitute for inspecting artifacts.
