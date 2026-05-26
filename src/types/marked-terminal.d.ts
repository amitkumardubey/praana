/**
 * Minimal type declarations for marked-terminal.
 */

declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";

  export interface MarkedTerminalOptions {
    /** Whether to reflow text to fit terminal width. Default: true */
    reflowText?: boolean;
    /** Show section prefix for headings (e.g., "h1. "). Default: true */
    showSectionPrefix?: boolean;
    /** Unescape HTML entities. Default: false */
    unescape?: boolean;
    /** Table options */
    table?: Record<string, unknown>;
    /** Code block options */
    code?: {
      theme?: string;
    };
  }

  export class markedTerminal {
    constructor(options?: MarkedTerminalOptions);
  }
}
