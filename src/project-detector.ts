import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as toml from "toml";
import * as yaml from "js-yaml";

// ---- Types ----

export interface ProjectDetectionResult {
  projectName?: string;
  description?: string;
  languages: string[];
  frameworks: string[];
  packageManagers: string[];
  scripts?: Record<string, string>;
  dependencies?: string[];
  monorepoTool?: string;
  ciCd: string[];
  hasDocker: boolean;
  hasGitignore: boolean;
  readme?: string;
}

export interface ProjectDetectionOptions {
  languages?: string[];
  frameworks?: string[];
}

interface ManifestDetectionRule {
  file: string;
  language?: string;
  framework?: string;
}

interface DependencyDetectionRule {
  depKey: string;
  language: string;
  framework?: string;
}

// ---- Detection tables ----

const MANIFEST_RULES: ManifestDetectionRule[] = [
  { file: "tsconfig.json", language: "TypeScript" },
  { file: "pyproject.toml", language: "Python" },
  { file: "go.mod", language: "Go" },
  { file: "Cargo.toml", language: "Rust" },
  { file: "Gemfile", language: "Ruby" },
  { file: "composer.json", language: "PHP" },
  { file: "pom.xml", language: "Java" },
  { file: "build.gradle", language: "Java" },
  { file: "build.gradle.kts", language: "Kotlin" },
  { file: "pubspec.yaml", language: "Dart" },
  { file: "mix.exs", language: "Elixir" },
  { file: "deno.json", language: "TypeScript", framework: "Deno" },
  { file: "deno.jsonc", language: "TypeScript", framework: "Deno" },
  { file: "*.csproj", language: "C#" },
  { file: "CMakeLists.txt", language: "C/C++" },
  { file: "Package.swift", language: "Swift" },
];

const DEPENDENCY_RULES: DependencyDetectionRule[] = [
  // Frontend frameworks
  { depKey: "react", language: "TypeScript", framework: "React" },
  { depKey: "next", language: "TypeScript", framework: "Next.js" },
  { depKey: "vue", language: "TypeScript", framework: "Vue" },
  { depKey: "@angular/core", language: "TypeScript", framework: "Angular" },
  { depKey: "svelte", language: "TypeScript", framework: "Svelte" },
  { depKey: "solid-js", language: "TypeScript", framework: "SolidJS" },
  { depKey: "astro", language: "TypeScript", framework: "Astro" },
  { depKey: "nuxt", language: "TypeScript", framework: "Nuxt" },
  // Backend frameworks (Node)
  { depKey: "express", language: "TypeScript", framework: "Express" },
  { depKey: "fastify", language: "TypeScript", framework: "Fastify" },
  { depKey: "hono", language: "TypeScript", framework: "Hono" },
  { depKey: "koa", language: "TypeScript", framework: "Koa" },
  { depKey: "nestjs", language: "TypeScript", framework: "NestJS" },
  { depKey: "@nestjs/core", language: "TypeScript", framework: "NestJS" },
  { depKey: "elysia", language: "TypeScript", framework: "Elysia" },
];

const MONOREPO_FILES: Array<[string, string]> = [
  ["pnpm-workspace.yaml", "pnpm Workspaces"],
  ["turbo.json", "Turborepo"],
  ["nx.json", "Nx"],
  ["lerna.json", "Lerna"],
  ["rush.json", "Rush"],
];

const PACKAGE_MANAGER_LOCKFILES: Array<[string, string]> = [
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["Cargo.lock", "cargo"],
  ["composer.lock", "composer"],
  ["Gemfile.lock", "bundler"],
  ["poetry.lock", "poetry"],
  ["uv.lock", "uv"],
  ["Pipfile.lock", "pipenv"],
  ["go.sum", "go modules"],
];

const CI_CD_FILES: Array<[string, string]> = [
  [".github/workflows", "GitHub Actions"],
  [".gitlab-ci.yml", "GitLab CI"],
  ["Jenkinsfile", "Jenkins"],
  [".circleci/config.yml", "CircleCI"],
  [".travis.yml", "Travis CI"],
  ["bitbucket-pipelines.yml", "Bitbucket Pipelines"],
  [".drone.yml", "Drone CI"],
  ["azure-pipelines.yml", "Azure Pipelines"],
];

// ---- Manifest parsers ----

function tryParseJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tryParseToml(path: string): Record<string, unknown> | null {
  try {
    return toml.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tryParseYaml(path: string): Record<string, unknown> | null {
  try {
    return yaml.load(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseGoMod(path: string): { module?: string; goVersion?: string; deps: string[] } {
  try {
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n");
    let moduleName: string | undefined;
    let goVersion: string | undefined;
    const deps: string[] = [];
    let inRequireBlock = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("module ")) {
        moduleName = trimmed.slice(7).trim();
      } else if (trimmed.startsWith("go ")) {
        goVersion = trimmed.slice(3).trim();
      } else if (trimmed === "require (") {
        inRequireBlock = true;
      } else if (trimmed === ")") {
        inRequireBlock = false;
      } else if (inRequireBlock && trimmed && !trimmed.startsWith("//")) {
        const parts = trimmed.split(/\s+/);
        if (parts[0]) deps.push(parts[0]);
      } else if (trimmed.startsWith("require ") && !trimmed.includes("(")) {
        const parts = trimmed.slice(8).trim().split(/\s+/);
        if (parts[0]) deps.push(parts[0]);
      }
    }
    return { module: moduleName, goVersion, deps };
  } catch {
    return { deps: [] };
  }
}

function parseGemfile(path: string): { rubyVersion?: string; gems: string[] } {
  try {
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n");
    let rubyVersion: string | undefined;
    const gems: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      const rubyMatch = trimmed.match(/^ruby\s+['"](.+)['"]/);
      if (rubyMatch) {
        rubyVersion = rubyMatch[1];
        continue;
      }
      const gemMatch = trimmed.match(/^gem\s+['"]([^'"]+)['"]/);
      if (gemMatch) {
        gems.push(gemMatch[1]);
      }
    }
    return { rubyVersion, gems };
  } catch {
    return { gems: [] };
  }
}

function detectCsprojFiles(cwd: string): string[] {
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".csproj"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function normalizeDependencyName(dep: string): string {
  return dep.split(/[><=!;\s\[]/)[0].trim().toLowerCase();
}

// ---- Detector helpers ----

function detectFromManifests(cwd: string): { languages: string[]; frameworks: string[] } {
  const languages = new Set<string>();
  const frameworks = new Set<string>();

  for (const rule of MANIFEST_RULES) {
    if (rule.file === "*.csproj") {
      for (const file of detectCsprojFiles(cwd)) {
        if (file.endsWith(".csproj")) {
          if (rule.language) languages.add(rule.language);
          if (rule.framework) frameworks.add(rule.framework);
          break;
        }
      }
      continue;
    }
    if (existsSync(join(cwd, rule.file))) {
      if (rule.language) languages.add(rule.language);
      if (rule.framework) frameworks.add(rule.framework);
    }
  }

  return { languages: [...languages], frameworks: [...frameworks] };
}

function detectFromPackageJson(
  cwd: string
): {
  projectName?: string;
  description?: string;
  scripts?: Record<string, string>;
  dependencies?: string[];
  extraLanguages: string[];
  extraFrameworks: string[];
  hasWorkspaces: boolean;
  packageManager?: string;
} | null {
  const pkgPath = join(cwd, "package.json");
  const pkg = tryParseJson(pkgPath);
  if (!pkg) return null;

  const extraLanguages = new Set<string>();
  const extraFrameworks = new Set<string>();

  const allDeps = {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
    ...((pkg.peerDependencies as Record<string, string>) ?? {}),
    ...((pkg.optionalDependencies as Record<string, string>) ?? {}),
  };

  for (const rule of DEPENDENCY_RULES) {
    if (rule.depKey in allDeps) {
      extraLanguages.add(rule.language);
      if (rule.framework) extraFrameworks.add(rule.framework);
    }
  }

  const depKeys = [
    ...Object.keys((pkg.dependencies as Record<string, string>) ?? {}),
    ...Object.keys((pkg.devDependencies as Record<string, string>) ?? {}),
    ...Object.keys((pkg.peerDependencies as Record<string, string>) ?? {}),
    ...Object.keys((pkg.optionalDependencies as Record<string, string>) ?? {}),
  ];

  return {
    projectName: typeof pkg.name === "string" ? pkg.name : undefined,
    description: typeof pkg.description === "string" ? pkg.description : undefined,
    scripts:
      pkg.scripts && typeof pkg.scripts === "object"
        ? (pkg.scripts as Record<string, string>)
        : undefined,
    dependencies: depKeys.slice(0, 10),
    extraLanguages: [...extraLanguages],
    extraFrameworks: [...extraFrameworks],
    hasWorkspaces: Boolean(pkg.workspaces),
    packageManager: typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined,
  };
}

function detectFromPyproject(
  cwd: string
): { projectName?: string; description?: string; deps: string[]; frameworks: string[] } | null {
  const path = join(cwd, "pyproject.toml");
  if (!existsSync(path)) return null;

  const data = tryParseToml(path);
  if (!data) return null;

  const project = data.project as Record<string, unknown> | undefined;
  const frameworks: string[] = [];

  const deps: string[] = [];
  if (project?.dependencies && Array.isArray(project.dependencies)) {
    for (const dep of project.dependencies as string[]) {
      const name = normalizeDependencyName(dep);
      if (name) deps.push(name);
      if (name === "django") frameworks.push("Django");
      else if (name === "flask") frameworks.push("Flask");
      else if (name === "fastapi") frameworks.push("FastAPI");
      else if (name === "starlette") frameworks.push("Starlette");
      else if (name === "litestar") frameworks.push("Litestar");
      else if (name === "tornado") frameworks.push("Tornado");
    }
  }

  return {
    projectName: typeof project?.name === "string" ? project.name : undefined,
    description: typeof project?.description === "string" ? project.description : undefined,
    deps,
    frameworks,
  };
}

function detectFromCargoToml(
  cwd: string
): { projectName?: string; description?: string; deps: string[]; frameworks: string[] } | null {
  const path = join(cwd, "Cargo.toml");
  if (!existsSync(path)) return null;

  const data = tryParseToml(path);
  if (!data) return null;

  const pkg = data.package as Record<string, unknown> | undefined;
  const rawDeps = (data.dependencies as Record<string, unknown>) ?? {};
  const deps = Object.keys(rawDeps).slice(0, 10);

  const frameworks: string[] = [];
  const depLower = deps.map((d) => d.toLowerCase());
  if (depLower.includes("axum")) frameworks.push("Axum");
  if (depLower.includes("actix-web") || depLower.includes("actix_web")) frameworks.push("Actix-web");
  if (depLower.includes("rocket")) frameworks.push("Rocket");
  if (depLower.includes("warp")) frameworks.push("Warp");
  if (depLower.includes("tokio")) frameworks.push("Tokio");

  return {
    projectName: typeof pkg?.name === "string" ? pkg.name : undefined,
    description: typeof pkg?.description === "string" ? pkg.description : undefined,
    deps,
    frameworks,
  };
}

function detectFromGoMod(cwd: string): { moduleName?: string; goVersion?: string; deps: string[]; frameworks: string[] } | null {
  const path = join(cwd, "go.mod");
  if (!existsSync(path)) return null;
  const parsed = parseGoMod(path);

  const frameworks: string[] = [];
  for (const dep of parsed.deps) {
    if (dep.includes("gin-gonic/gin")) frameworks.push("Gin");
    else if (dep.includes("labstack/echo")) frameworks.push("Echo");
    else if (dep.includes("gofiber/fiber")) frameworks.push("Fiber");
    else if (dep.includes("go-chi/chi")) frameworks.push("Chi");
  }

  return { moduleName: parsed.module, goVersion: parsed.goVersion, deps: parsed.deps.slice(0, 10), frameworks };
}

function detectFromGemfile(cwd: string): { rubyVersion?: string; gems: string[]; frameworks: string[] } | null {
  const path = join(cwd, "Gemfile");
  if (!existsSync(path)) return null;
  const parsed = parseGemfile(path);

  const frameworks: string[] = [];
  if (parsed.gems.includes("rails")) frameworks.push("Rails");
  if (parsed.gems.includes("sinatra")) frameworks.push("Sinatra");
  if (parsed.gems.includes("hanami")) frameworks.push("Hanami");

  return { rubyVersion: parsed.rubyVersion, gems: parsed.gems.slice(0, 10), frameworks };
}

function detectFromComposerJson(
  cwd: string
): { projectName?: string; description?: string; deps: string[]; frameworks: string[] } | null {
  const path = join(cwd, "composer.json");
  const data = tryParseJson(path);
  if (!data) return null;

  const require = (data.require as Record<string, string>) ?? {};
  const deps = Object.keys(require).filter((d) => !d.startsWith("php")).slice(0, 10);
  const frameworks: string[] = [];
  if (deps.some((d) => d.includes("laravel/framework"))) frameworks.push("Laravel");
  if (deps.some((d) => d.includes("symfony/"))) frameworks.push("Symfony");

  return {
    projectName: typeof data.name === "string" ? data.name : undefined,
    description: typeof data.description === "string" ? data.description : undefined,
    deps,
    frameworks,
  };
}

function detectFromPubspec(
  cwd: string
): { projectName?: string; description?: string; deps: string[]; frameworks: string[] } | null {
  const path = join(cwd, "pubspec.yaml");
  if (!existsSync(path)) return null;
  const data = tryParseYaml(path);
  if (!data) return null;

  const rawDeps = (data.dependencies as Record<string, unknown>) ?? {};
  const deps = Object.keys(rawDeps).filter((d) => d !== "flutter" && d !== "sdk").slice(0, 10);
  const frameworks: string[] = [];
  if ("flutter" in rawDeps) frameworks.push("Flutter");

  return {
    projectName: typeof data.name === "string" ? data.name : undefined,
    description: typeof data.description === "string" ? data.description : undefined,
    deps,
    frameworks,
  };
}

function detectPackageManagers(cwd: string): string[] {
  const found: string[] = [];
  const pkg = tryParseJson(join(cwd, "package.json"));
  if (typeof pkg?.packageManager === "string") {
    found.push(pkg.packageManager.split("@")[0]);
  }
  for (const [lockfile, name] of PACKAGE_MANAGER_LOCKFILES) {
    if (existsSync(join(cwd, lockfile))) {
      found.push(name);
    }
  }
  return [...new Set(found)];
}

function detectMonorepo(cwd: string, pkgHasWorkspaces: boolean): string | undefined {
  for (const [file, tool] of MONOREPO_FILES) {
    if (existsSync(join(cwd, file))) return tool;
  }
  if (pkgHasWorkspaces) return "npm/yarn workspaces";
  return undefined;
}

function detectCiCd(cwd: string): string[] {
  const found: string[] = [];
  for (const [file, name] of CI_CD_FILES) {
    if (existsSync(join(cwd, file))) found.push(name);
  }
  return found;
}

function detectReadme(cwd: string): string | undefined {
  for (const name of ["README.md", "README.rst", "README.txt", "README"]) {
    try {
      const content = readFileSync(join(cwd, name), "utf-8");
      const lines = content.split("\n").slice(0, 50).join("\n").trim();
      return lines.length > 0 ? lines : undefined;
    } catch {
      // try next
    }
  }
  return undefined;
}

// ---- ProjectDetector ----

export class ProjectDetector {
  static detect(
    cwd: string,
    opts: ProjectDetectionOptions = {}
  ): ProjectDetectionResult | null {
    const languages = new Set<string>();
    const frameworks = new Set<string>();
    const packageManagers = detectPackageManagers(cwd);
    const ciCd = detectCiCd(cwd);
    const hasDocker =
      existsSync(join(cwd, "Dockerfile")) ||
      existsSync(join(cwd, "docker-compose.yml")) ||
      existsSync(join(cwd, "docker-compose.yaml"));
    const hasGitignore = existsSync(join(cwd, ".gitignore"));
    const readme = detectReadme(cwd);

    let projectName: string | undefined;
    let description: string | undefined;
    let scripts: Record<string, string> | undefined;
    const dependenciesSet = new Set<string>();

    // Manifest-based language/framework detection
    const manifestResult = detectFromManifests(cwd);
    for (const lang of manifestResult.languages) languages.add(lang);
    for (const fw of manifestResult.frameworks) frameworks.add(fw);

    // package.json
    const pkg = detectFromPackageJson(cwd);
    if (pkg) {
      if (pkg.projectName) projectName = pkg.projectName;
      if (pkg.description) description = pkg.description;
      if (pkg.scripts) scripts = pkg.scripts;
      if (pkg.dependencies) for (const dep of pkg.dependencies) dependenciesSet.add(dep);
      for (const lang of pkg.extraLanguages) languages.add(lang);
      for (const fw of pkg.extraFrameworks) frameworks.add(fw);
      if (existsSync(join(cwd, "tsconfig.json"))) {
        languages.add("TypeScript");
      } else {
        languages.add("JavaScript");
      }
    }

    // pyproject.toml
    const py = detectFromPyproject(cwd);
    if (py) {
      if (!projectName && py.projectName) projectName = py.projectName;
      if (!description && py.description) description = py.description;
      if (py.deps) for (const dep of py.deps) dependenciesSet.add(dep);
      for (const fw of py.frameworks) frameworks.add(fw);
    }

    // Cargo.toml
    const cargo = detectFromCargoToml(cwd);
    if (cargo) {
      if (!projectName && cargo.projectName) projectName = cargo.projectName;
      if (!description && cargo.description) description = cargo.description;
      for (const dep of cargo.deps) dependenciesSet.add(dep);
      for (const fw of cargo.frameworks) frameworks.add(fw);
    }

    // go.mod
    const goMod = detectFromGoMod(cwd);
    if (goMod) {
      if (!projectName && goMod.moduleName) projectName = goMod.moduleName;
      for (const fw of goMod.frameworks) frameworks.add(fw);
    }

    // Gemfile
    const gem = detectFromGemfile(cwd);
    if (gem) {
      for (const fw of gem.frameworks) frameworks.add(fw);
    }

    // composer.json
    const composer = detectFromComposerJson(cwd);
    if (composer) {
      if (!projectName && composer.projectName) projectName = composer.projectName;
      if (!description && composer.description) description = composer.description;
      for (const fw of composer.frameworks) frameworks.add(fw);
    }

    // pubspec.yaml
    const pubspec = detectFromPubspec(cwd);
    if (pubspec) {
      if (!projectName && pubspec.projectName) projectName = pubspec.projectName;
      if (!description && pubspec.description) description = pubspec.description;
      for (const fw of pubspec.frameworks) frameworks.add(fw);
    }

    const monorepoTool = detectMonorepo(cwd, pkg?.hasWorkspaces ?? false);

    const detectedLanguages = [...languages];
    const detectedFrameworks = [...frameworks];
    const finalLanguages = opts.languages?.length ? [...opts.languages] : detectedLanguages;
    const finalFrameworks = opts.frameworks?.length ? [...opts.frameworks] : detectedFrameworks;
    const finalDependencies = dependenciesSet.size > 0 ? [...dependenciesSet] : undefined;

    // Empty project — nothing detected
    if (
      languages.size === 0 &&
      frameworks.size === 0 &&
      packageManagers.length === 0 &&
      !projectName &&
      !hasDocker &&
      !hasGitignore &&
      ciCd.length === 0 &&
      !readme
    ) {
      return null;
    }

    return {
      projectName,
      description,
      languages: finalLanguages,
      frameworks: finalFrameworks,
      packageManagers,
      scripts,
      dependencies: finalDependencies,
      monorepoTool,
      ciCd,
      hasDocker,
      hasGitignore,
      readme,
    };
  }
}

// ---- Formatter ----

/**
 * Convert a ProjectDetectionResult into the compact string used by the prompt
 * compiler's ## Project Stack section. Returns null when result is null.
 */
export function formatProjectContext(
  result: ProjectDetectionResult,
  opts: { maxChars?: number } = {}
): string {
  const { maxChars = 1200 } = opts;
  const parts: string[] = [];

  if (result.projectName) parts.push(`Project: ${result.projectName}`);
  if (result.description) parts.push(`Description: ${result.description}`);
  if (result.languages.length > 0) parts.push(`Languages: ${result.languages.join(", ")}`);
  if (result.frameworks.length > 0) parts.push(`Frameworks: ${result.frameworks.join(", ")}`);
  if (result.packageManagers.length > 0) parts.push(`Package Manager: ${result.packageManagers[0]}`);
  if (result.monorepoTool) parts.push(`Monorepo: ${result.monorepoTool}`);

  if (result.scripts) {
    const scriptKeys = Object.keys(result.scripts).join(", ");
    if (scriptKeys) parts.push(`Scripts: ${scriptKeys}`);
  }
  if (result.dependencies && result.dependencies.length > 0) {
    const more = result.dependencies.length > 10 ? "..." : "";
    parts.push(`Dependencies: ${result.dependencies.join(", ")}${more}`);
  }

  if (result.ciCd.length > 0) parts.push(`CI/CD: ${result.ciCd.join(", ")}`);
  if (result.hasDocker) parts.push("Docker: yes");
  if (result.hasGitignore) parts.push("Has .gitignore");

  if (result.readme) parts.push(`README (untrusted): ${result.readme}`);

  const summary = parts.join("\n");
  return summary.length > maxChars ? summary.slice(0, maxChars) + "..." : summary;
}

/**
 * Detect project context and return a formatted string summary.
 * Returns null when no meaningful signals are found.
 * This is the main entry point consumed by session.ts.
 */
export function buildProjectContext(
  cwd: string,
  opts: { languages?: string[]; frameworks?: string[] } = {}
): string | null {
  const result = ProjectDetector.detect(cwd, opts);
  if (!result) return null;
  return formatProjectContext(result);
}
