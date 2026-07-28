/**
 * Create a synthetic large session for manual TTY resume testing.
 *
 * Run with:
 *   bun run scripts/create-large-session.ts
 *
 * Prints the new session id so you can resume it:
 *   bun start -- --incognito resume <session_id>
 */
import { ulid } from "ulid";
import { loadConfig } from "../src/config.js";
import { EventLog, writeSessionMeta } from "../src/event-log.js";
import { generateLargeTranscriptEvents } from "../tests/fixtures/large-transcript.js";

async function main() {
  const config = loadConfig();
  const sessionId = ulid();
  const logDir = config.session.log_dir;

  writeSessionMeta(logDir, {
    session_id: sessionId,
    started_at: Date.now(),
    cwd: process.cwd(),
    agent: "praana",
  });

  const eventLog = new EventLog(sessionId, logDir);
  const events = generateLargeTranscriptEvents({ turns: 250 });
  for (const event of events) {
    eventLog.append({
      kind: event.kind,
      actor: event.actor,
      payload: event.payload,
      event_id: event.event_id,
      timestamp: event.timestamp,
    });
  }

  console.log(sessionId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
