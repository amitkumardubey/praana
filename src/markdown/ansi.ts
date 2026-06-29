/**
 * Raw ANSI escape code helpers.
 * No external dependencies — can be inlined when extracting as a package.
 */

const E = "\x1b[";

export const ansi = {
  bold:         (s: string) => `${E}1m${s}${E}22m`,
  dim:          (s: string) => `${E}2m${s}${E}22m`,
  italic:       (s: string) => `${E}3m${s}${E}23m`,
  underline:    (s: string) => `${E}4m${s}${E}24m`,
  strikethrough:(s: string) => `${E}9m${s}${E}29m`,
  reset:        `${E}0m`,

  /** 24-bit foreground colour from a CSS hex string, e.g. "#88C0D0". */
  fg: (hex: string, s: string): string => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${E}38;2;${r};${g};${b}m${s}${E}39m`;
  },
} as const;
