/** Thrown when a requested session does not exist on disk. */
export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`Session ${sessionId} not found.`);
    this.name = "SessionNotFoundError";
    this.sessionId = sessionId;
  }
}

/** Thrown when a session-id prefix matches more than one session directory. */
export class AmbiguousSessionPrefixError extends Error {
  readonly prefix: string;
  readonly matches: string[];
  constructor(prefix: string, matches: string[]) {
    const shown = matches.slice(0, 5).join(", ");
    const more = matches.length > 5 ? `, +${matches.length - 5} more` : "";
    super(
      `Ambiguous session prefix '${prefix}': ${matches.length} sessions match ` +
        `(${shown}${more}). Use a longer prefix or the full session id.`,
    );
    this.name = "AmbiguousSessionPrefixError";
    this.prefix = prefix;
    this.matches = matches;
  }
}
