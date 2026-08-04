# LLM stream error UI design

## Goal
Prevent raw logger-formatted LLM stream errors from appearing in the interactive TUI transcript/prompt area when a selected model is invalid or unavailable.

## Design
- Keep `LLM_STREAM_ERROR` logging and event telemetry unchanged.
- Change the OpenTUI sink so `onError()` does not create a transcript system line for LLM-domain errors.
- Continue showing an error toast for LLM errors, but use the error message supplied by the turn layer rather than the logger-formatted prefix.
- The existing turn fallback remains responsible for the actionable provider/model failure message. Non-LLM warnings and errors retain their existing transcript and toast behavior.

## Testing
- Add a sink regression test asserting that an LLM error produces a toast but no transcript system-line event.
- Preserve coverage that turn-level stream errors are surfaced and logged.
