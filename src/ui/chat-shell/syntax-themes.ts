/* Syntax-highlighting themes for fenced code blocks.
 *
 * cli-highlight's `theme` option takes a Theme *object* (a map of
 * highlight.js scope names → styling functions), NOT a name string. Passing a
 * bare string (e.g. "nord", "solarized-dark") silently resolves to the default
 * theme — it never changes the colours. So named themes must be defined as
 * real objects here.
 */
import chalk from "chalk";
import type { Theme } from "cli-highlight";
import { NORD_COLORS as c } from "./palette.js";

/** Nord syntax theme, mapped to highlight.js scopes. */
export const NORD_SYNTAX: Theme = {
  keyword: chalk.hex(c.nord9),
  built_in: chalk.hex(c.nord7),
  type: chalk.hex(c.nord7),
  literal: chalk.hex(c.nord9),
  number: chalk.hex(c.nord15),
  regexp: chalk.hex(c.nord13),
  string: chalk.hex(c.nord14),
  subst: chalk.hex(c.nord4),
  symbol: chalk.hex(c.nord15),
  class: chalk.hex(c.nord7),
  function: chalk.hex(c.nord8),
  title: chalk.hex(c.nord8),
  params: chalk.hex(c.nord4),
  comment: chalk.hex(c.nord3b),
  doctag: chalk.hex(c.nord3b),
  meta: chalk.hex(c.nord10),
  "meta-keyword": chalk.hex(c.nord9),
  "meta-string": chalk.hex(c.nord14),
  section: chalk.hex(c.nord8),
  tag: chalk.hex(c.nord9),
  name: chalk.hex(c.nord9),
  "builtin-name": chalk.hex(c.nord7),
  attr: chalk.hex(c.nord7),
  attribute: chalk.hex(c.nord7),
  variable: chalk.hex(c.nord4),
  bullet: chalk.hex(c.nord13),
  code: chalk.hex(c.nord8),
  emphasis: (s: string) => chalk.italic(chalk.hex(c.nord4)(s)),
  strong: (s: string) => chalk.bold(chalk.hex(c.nord4)(s)),
  formula: chalk.hex(c.nord8),
  link: chalk.hex(c.nord8),
  quote: chalk.hex(c.nord3b),
  "selector-tag": chalk.hex(c.nord9),
  "selector-id": chalk.hex(c.nord8),
  "selector-class": chalk.hex(c.nord7),
  "selector-attr": chalk.hex(c.nord15),
  "selector-pseudo": chalk.hex(c.nord15),
  "template-tag": chalk.hex(c.nord9),
  "template-variable": chalk.hex(c.nord15),
  addition: chalk.hex(c.nord14),
  deletion: chalk.hex(c.nord11),
  default: chalk.hex(c.nord4),
};

const NAMED_SYNTAX_THEMES: Record<string, Theme> = {
  nord: NORD_SYNTAX,
  "nord-dark": NORD_SYNTAX,
};

/**
 * Resolve a syntax-theme name to a cli-highlight value.
 * Known named themes return a real Theme object; anything else falls back to
 * the name string (cli-highlight's built-in default behaviour).
 */
export function resolveSyntaxTheme(name: string): Theme | string {
  return NAMED_SYNTAX_THEMES[name] ?? name;
}
