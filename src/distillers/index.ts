import { DiffDistiller } from "./git-diff.js";
import { GenericDistiller, LogDistiller } from "./generic.js";
import { TestDistiller } from "./npm-test.js";
import { SearchDistiller } from "./rg-results.js";
import { BuildDistiller } from "./tsc-errors.js";
import { DistillerRegistry } from "../context-engine/distiller.js";

export function createDefaultDistillerRegistry(): DistillerRegistry {
  const registry = new DistillerRegistry();
  registry.register(new DiffDistiller());
  registry.register(new TestDistiller());
  registry.register(new BuildDistiller());
  registry.register(new SearchDistiller());
  registry.register(new LogDistiller());
  registry.register(new GenericDistiller());
  return registry;
}
