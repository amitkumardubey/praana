/**
 * Types for the standalone ANSI markdown renderer.
 * This module has no imports from the rest of the project.
 */
import type { Theme as CliHighlightTheme } from "cli-highlight";

/** cli-highlight theme object. Re-exported so consumers don't depend on cli-highlight directly. */
export type SyntaxTheme = CliHighlightTheme;

export interface RendererOptions {
  /** Enable ANSI syntax highlighting inside fenced code blocks. Default: false. */
  syntaxHighlight?: boolean;
  /** cli-highlight theme object or built-in name string. Default: "nord". */
  syntaxTheme?: SyntaxTheme | string;
  /** Column width of horizontal rules. Default: 40. */
  hrWidth?: number;
}
