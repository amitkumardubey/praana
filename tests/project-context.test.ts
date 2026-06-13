import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildProjectContext, Session } from "../src/session.js";
import { ProjectDetector, formatProjectContext } from "../src/project-detector.js";

// ---- Helpers ----

function makeDir(): string {
  const dir = join(tmpdir(), `praana-pctx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- Suite: buildProjectContext (session.ts re-export) ----

describe("buildProjectContext", () => {
  let testDir: string;

  beforeEach(() => { testDir = makeDir(); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it("returns null for empty directory", () => {
    expect(buildProjectContext(testDir)).toBeNull();
  });

  it("does not load project context when project_detection.enabled is false", async () => {
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));

    const session = await Session.create(testDir, {
      llm: { provider: "openai", model: "test", context_window: 1000 },
      memory: { enabled: false, summarizer: "disabled" },
      compiler: { token_budget: 1000, recent_turns: 1 },
      tiers: { idle_soft_after_turns: 1, idle_hard_after_turns: 1 },
      session: { log_dir: join(testDir, "sessions") },
      consolidation: { enabled: false, promotion_threshold: 1, run_delay_seconds: 1 },
      shell: { enabled: false, allowed_paths: [] },
      edit: { confirm: false },
      skills: { enabled: false, max_depth: 1 },
      ui: { mode: "tui", screen: "preserve" },
      context_engine: {
        enabled: false,
        measurement_mode: false,
        artifact_inline_threshold: 1,
        artifact_ttl_turns: 1,
        distiller: { default_intensity: "full" },
        llm_digest: false,
        activity_log_max_entries: 1,
        checkpoint_enabled: false,
        scoring: { w_pin: 1, w_recency: 0, w_relevance: 0 },
        pressure: { compact_at: 1, emergency_at: 1 },
      },
      project_detection: { enabled: false },
    });

    expect(session.projectContext).toBeNull();
  });

  it("applies manual language and framework overrides", () => {
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({ name: "react-app", dependencies: { react: "^18.0.0" } })
    );
    writeFileSync(join(testDir, "tsconfig.json"), "{}");

    const result = buildProjectContext(testDir, {
      languages: ["Python"],
      frameworks: ["FastAPI"],
    });

    expect(result).toContain("Languages: Python");
    expect(result).toContain("Frameworks: FastAPI");
    expect(result).not.toContain("TypeScript");
    expect(result).not.toContain("React");
  });

  it("parses package.json and surfaces project name, description, scripts, deps", () => {
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({
        name: "my-app",
        description: "A cool app",
        scripts: { build: "tsc", start: "node dist/main.js" },
        dependencies: { react: "^18.0.0", lodash: "^4.17.0" },
      })
    );
    writeFileSync(join(testDir, "tsconfig.json"), "{}");

    const result = buildProjectContext(testDir)!;
    expect(result).toContain("Project: my-app");
    expect(result).toContain("Description: A cool app");
    expect(result).toContain("Scripts: build, start");
    expect(result).toContain("Dependencies: react, lodash");
  });

  it("detects TypeScript from tsconfig.json", () => {
    writeFileSync(join(testDir, "tsconfig.json"), "{}");
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));
    const result = buildProjectContext(testDir);
    expect(result).toContain("TypeScript");
  });

  it("detects Python from pyproject.toml", () => {
    writeFileSync(join(testDir, "pyproject.toml"), "[project]\nname = 'test'");
    const result = buildProjectContext(testDir);
    expect(result).toContain("Python");
  });

  it("detects Go from go.mod", () => {
    writeFileSync(join(testDir, "go.mod"), "module myproject\n\ngo 1.21");
    const result = buildProjectContext(testDir);
    expect(result).toContain("Go");
  });

  it("detects Rust from Cargo.toml", () => {
    writeFileSync(join(testDir, "Cargo.toml"), "[package]\nname = \"mycrate\"");
    const result = buildProjectContext(testDir);
    expect(result).toContain("Rust");
  });

  it("detects Ruby from Gemfile", () => {
    writeFileSync(join(testDir, "Gemfile"), 'source "https://rubygems.org"');
    const result = buildProjectContext(testDir);
    expect(result).toContain("Ruby");
  });

  it("reports .gitignore presence", () => {
    writeFileSync(join(testDir, ".gitignore"), "node_modules/\n");
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));
    const result = buildProjectContext(testDir);
    expect(result).toContain("Has .gitignore");
  });

  it("does not mention .gitignore when absent", () => {
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));
    const result = buildProjectContext(testDir);
    expect(result).not.toContain(".gitignore");
  });

  it("includes README.md content (first 50 lines)", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}: content`);
    writeFileSync(join(testDir, "README.md"), lines.join("\n"));
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));
    const result = buildProjectContext(testDir)!;
    expect(result).toContain("README (untrusted):");
    expect(result).toContain("Line 1: content");
    expect(result).toContain("Line 20: content");
  });

  it("caps output at 1200 chars with ellipsis", () => {
    const longDescription = "x".repeat(2000);
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({ name: "big-project", description: longDescription })
    );
    writeFileSync(join(testDir, "tsconfig.json"), "{}");
    writeFileSync(join(testDir, "README.md"), "A".repeat(500));

    const result = buildProjectContext(testDir)!;
    expect(result.length).toBeLessThanOrEqual(1203); // 1200 + "..."
    expect(result.endsWith("...")).toBe(true);
  });
});

// ---- Suite: ProjectDetector.detect ----

describe("ProjectDetector.detect", () => {
  let testDir: string;

  beforeEach(() => { testDir = makeDir(); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it("returns null for completely empty directory", () => {
    expect(ProjectDetector.detect(testDir)).toBeNull();
  });

  it("detects README-only projects as meaningful context", () => {
    writeFileSync(join(testDir, "README.md"), "# README-only project");

    const result = ProjectDetector.detect(testDir);
    expect(result).not.toBeNull();
    expect(result!.readme).toContain("README-only project");
  });

  it("detects CI-only projects as meaningful context", () => {
    writeFileSync(join(testDir, ".gitlab-ci.yml"), "stages:\n  - test");

    const result = ProjectDetector.detect(testDir);
    expect(result).not.toBeNull();
    expect(result!.ciCd).toContain("GitLab CI");
  });

  it("detects gitignore-only projects as meaningful context", () => {
    writeFileSync(join(testDir, ".gitignore"), "node_modules/\n");

    const result = ProjectDetector.detect(testDir);
    expect(result).not.toBeNull();
    expect(result!.hasGitignore).toBe(true);
  });

  // -- Multi-stack / polyglot --

  it("reports multiple languages for polyglot project (TS + Python)", () => {
    writeFileSync(join(testDir, "tsconfig.json"), "{}");
    writeFileSync(join(testDir, "pyproject.toml"), "[project]\nname = 'service'");
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "web" }));

    const result = ProjectDetector.detect(testDir)!;
    expect(result.languages).toContain("TypeScript");
    expect(result.languages).toContain("Python");
  });

  it("keeps JavaScript when Python is also detected", () => {
    writeFileSync(join(testDir, "pyproject.toml"), "[project]\nname = 'service'");
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "web" }));

    const result = ProjectDetector.detect(testDir)!;
    expect(result.languages).toContain("JavaScript");
    expect(result.languages).toContain("Python");
  });

  it("does NOT stop at first language match (no break)", () => {
    writeFileSync(join(testDir, "tsconfig.json"), "{}");
    writeFileSync(join(testDir, "Cargo.toml"), "[package]\nname = \"service\"");
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "hybrid" }));

    const result = ProjectDetector.detect(testDir)!;
    expect(result.languages).toContain("TypeScript");
    expect(result.languages).toContain("Rust");
  });

  it("overrides auto-detected languages and frameworks when manual values are provided", () => {
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "^18.0.0" } })
    );
    writeFileSync(join(testDir, "tsconfig.json"), "{}");

    const result = ProjectDetector.detect(testDir, {
      languages: ["Python"],
      frameworks: ["FastAPI"],
    })!;

    expect(result.languages).toEqual(["Python"]);
    expect(result.frameworks).toEqual(["FastAPI"]);
  });

  // -- Framework detection from dependencies --

  it("detects React framework from package.json dependencies", () => {
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "^18.0.0" } })
    );
    writeFileSync(join(testDir, "tsconfig.json"), "{}");

    const result = ProjectDetector.detect(testDir)!;
    expect(result.frameworks).toContain("React");
  });

  it("detects Next.js from package.json dependencies", () => {
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { next: "^14.0.0" } })
    );
    const result = ProjectDetector.detect(testDir)!;
    expect(result.frameworks).toContain("Next.js");
  });

  it("detects multiple frameworks in fullstack project", () => {
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { next: "^14.0.0", express: "^4.0.0" } })
    );
    const result = ProjectDetector.detect(testDir)!;
    expect(result.frameworks).toContain("Next.js");
    expect(result.frameworks).toContain("Express");
  });

  // -- Manifest parsers --

  it("extracts project name and description from pyproject.toml", () => {
    writeFileSync(
      join(testDir, "pyproject.toml"),
      `[project]\nname = "myservice"\ndescription = "A Python service"\ndependencies = ["fastapi>=0.100.0"]`
    );

    const result = ProjectDetector.detect(testDir)!;
    expect(result.projectName).toBe("myservice");
    expect(result.description).toBe("A Python service");
    expect(result.frameworks).toContain("FastAPI");
  });

  it("normalizes Python dependency extras when parsing pyproject.toml", () => {
    writeFileSync(
      join(testDir, "pyproject.toml"),
      `[project]\ndependencies = ["requests[security]>=2.0", "django>=4.0"]`
    );

    const result = ProjectDetector.detect(testDir)!;
    expect(result.dependencies).toContain("requests");
    expect(result.frameworks).toContain("Django");
  });

  it("detects Django from pyproject.toml dependencies", () => {
    writeFileSync(
      join(testDir, "pyproject.toml"),
      `[project]\nname = "web"\ndependencies = ["django>=4.0"]`
    );
    const result = ProjectDetector.detect(testDir)!;
    expect(result.frameworks).toContain("Django");
  });

  it("extracts name and description from Cargo.toml", () => {
    writeFileSync(
      join(testDir, "Cargo.toml"),
      `[package]\nname = "mycrate"\ndescription = "A Rust crate"\n\n[dependencies]\naxum = "0.7"`
    );

    const result = ProjectDetector.detect(testDir)!;
    expect(result.projectName).toBe("mycrate");
    expect(result.description).toBe("A Rust crate");
    expect(result.frameworks).toContain("Axum");
  });

  it("extracts module name from go.mod", () => {
    writeFileSync(join(testDir, "go.mod"), "module github.com/org/myapp\n\ngo 1.22\n");

    const result = ProjectDetector.detect(testDir)!;
    expect(result.projectName).toBe("github.com/org/myapp");
  });

  it("detects Rails from Gemfile", () => {
    writeFileSync(
      join(testDir, "Gemfile"),
      `source "https://rubygems.org"\n\ngem "rails", "~> 7.0"`
    );

    const result = ProjectDetector.detect(testDir)!;
    expect(result.languages).toContain("Ruby");
    expect(result.frameworks).toContain("Rails");
  });

  it("detects C# from csproj files", () => {
    writeFileSync(join(testDir, "Service.csproj"), `<Project Sdk="Microsoft.NET.Sdk" />`);

    const result = ProjectDetector.detect(testDir)!;
    expect(result.languages).toContain("C#");
  });

  it("extracts project name from composer.json (PHP)", () => {
    writeFileSync(
      join(testDir, "composer.json"),
      JSON.stringify({ name: "vendor/myapp", description: "A PHP app", require: { "php": ">=8.0" } })
    );

    const result = ProjectDetector.detect(testDir)!;
    expect(result.languages).toContain("PHP");
    expect(result.projectName).toBe("vendor/myapp");
  });

  it("extracts name and detects Flutter from pubspec.yaml", () => {
    writeFileSync(
      join(testDir, "pubspec.yaml"),
      `name: my_flutter_app\ndescription: A Flutter app\nenvironment:\n  sdk: ">=3.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n  http: ^1.0.0`
    );

    const result = ProjectDetector.detect(testDir)!;
    expect(result.languages).toContain("Dart");
    expect(result.frameworks).toContain("Flutter");
    expect(result.projectName).toBe("my_flutter_app");
  });

  // -- Package manager detection --

  it("detects pnpm from pnpm-lock.yaml", () => {
    writeFileSync(join(testDir, "pnpm-lock.yaml"), "lockfileVersion: 6.0");
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));

    const result = ProjectDetector.detect(testDir)!;
    expect(result.packageManagers).toContain("pnpm");
  });

  it("detects yarn from yarn.lock", () => {
    writeFileSync(join(testDir, "yarn.lock"), "# yarn lock");
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));

    const result = ProjectDetector.detect(testDir)!;
    expect(result.packageManagers).toContain("yarn");
  });

  it("detects bun from bun.lockb", () => {
    writeFileSync(join(testDir, "bun.lockb"), "");
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));

    const result = ProjectDetector.detect(testDir)!;
    expect(result.packageManagers).toContain("bun");
  });

  it("detects npm from package-lock.json", () => {
    writeFileSync(join(testDir, "package-lock.json"), "{}");
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));

    const result = ProjectDetector.detect(testDir)!;
    expect(result.packageManagers).toContain("npm");
  });

  it("detects package manager from package.json packageManager field", () => {
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test", packageManager: "pnpm@9.0.0" }));

    const result = ProjectDetector.detect(testDir)!;
    expect(result.packageManagers).toContain("pnpm");
  });

  it("detects poetry from poetry.lock", () => {
    writeFileSync(join(testDir, "poetry.lock"), "");
    writeFileSync(join(testDir, "pyproject.toml"), "[project]\nname = 'test'");

    const result = ProjectDetector.detect(testDir)!;
    expect(result.packageManagers).toContain("poetry");
  });

  it("detects cargo from Cargo.lock", () => {
    writeFileSync(join(testDir, "Cargo.lock"), "");
    writeFileSync(join(testDir, "Cargo.toml"), "[package]\nname = \"test\"");

    const result = ProjectDetector.detect(testDir)!;
    expect(result.packageManagers).toContain("cargo");
  });

  // -- Monorepo detection --

  it("detects Turborepo from turbo.json", () => {
    writeFileSync(join(testDir, "turbo.json"), "{}");
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "monorepo" }));

    const result = ProjectDetector.detect(testDir)!;
    expect(result.monorepoTool).toBe("Turborepo");
  });

  it("detects pnpm Workspaces from pnpm-workspace.yaml", () => {
    writeFileSync(join(testDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'");
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "mono" }));

    const result = ProjectDetector.detect(testDir)!;
    expect(result.monorepoTool).toBe("pnpm Workspaces");
  });

  it("detects npm workspaces from package.json workspaces field", () => {
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({ name: "mono", workspaces: ["packages/*"] })
    );

    const result = ProjectDetector.detect(testDir)!;
    expect(result.monorepoTool).toBe("npm/yarn workspaces");
  });

  // -- CI/CD detection --

  it("detects GitHub Actions from .github/workflows directory", () => {
    mkdirSync(join(testDir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(testDir, ".github", "workflows", "ci.yml"), "on: push");
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));

    const result = ProjectDetector.detect(testDir)!;
    expect(result.ciCd).toContain("GitHub Actions");
  });

  it("detects GitLab CI from .gitlab-ci.yml", () => {
    writeFileSync(join(testDir, ".gitlab-ci.yml"), "stages:\n  - build");
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));

    const result = ProjectDetector.detect(testDir)!;
    expect(result.ciCd).toContain("GitLab CI");
  });

  // -- Docker detection --

  it("detects Docker from Dockerfile", () => {
    writeFileSync(join(testDir, "Dockerfile"), "FROM node:22");
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));

    const result = ProjectDetector.detect(testDir)!;
    expect(result.hasDocker).toBe(true);
  });

  it("detects Docker from docker-compose.yml", () => {
    writeFileSync(join(testDir, "docker-compose.yml"), "version: '3'");
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));

    const result = ProjectDetector.detect(testDir)!;
    expect(result.hasDocker).toBe(true);
  });

  it("hasDocker is false when no Docker files present", () => {
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));
    const result = ProjectDetector.detect(testDir)!;
    expect(result.hasDocker).toBe(false);
  });

  // -- Graceful degradation --

  it("skips malformed package.json silently and continues", () => {
    writeFileSync(join(testDir, "package.json"), "{ invalid json }");
    writeFileSync(join(testDir, "tsconfig.json"), "{}");

    // Should still detect TypeScript from tsconfig even if package.json is broken
    const result = ProjectDetector.detect(testDir);
    expect(result).not.toBeNull();
    expect(result!.languages).toContain("TypeScript");
  });

  it("skips malformed pyproject.toml silently", () => {
    writeFileSync(join(testDir, "pyproject.toml"), "{ this is not valid toml !!!");
    writeFileSync(join(testDir, "Cargo.toml"), "[package]\nname = \"ok\"");

    const result = ProjectDetector.detect(testDir);
    expect(result).not.toBeNull();
    expect(result!.languages).toContain("Rust");
  });

  // -- README detection --

  it("includes README.md content (first 50 lines)", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`);
    writeFileSync(join(testDir, "README.md"), lines.join("\n"));
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));

    const result = ProjectDetector.detect(testDir)!;
    expect(result.readme).toContain("Line 1");
    expect(result.readme).toContain("Line 50");
    expect(result.readme).not.toContain("Line 51");
  });

  it("returns null readme when README is whitespace only", () => {
    writeFileSync(join(testDir, "README.md"), "\n\n\n");
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));

    const result = ProjectDetector.detect(testDir)!;
    expect(result.readme).toBeUndefined();
  });
});

// ---- Suite: formatProjectContext ----

describe("formatProjectContext", () => {
  it("formats a complete result into a readable string", () => {
    const result = {
      projectName: "my-app",
      description: "A fullstack app",
      languages: ["TypeScript", "Python"],
      frameworks: ["Next.js", "FastAPI"],
      packageManagers: ["pnpm"],
      scripts: { build: "next build", test: "vitest" },
      dependencies: ["next", "react"],
      monorepoTool: undefined,
      ciCd: ["GitHub Actions"],
      hasDocker: true,
      hasGitignore: true,
      readme: "# My App",
    };

    const output = formatProjectContext(result);
    expect(output).toContain("Project: my-app");
    expect(output).toContain("Languages: TypeScript, Python");
    expect(output).toContain("Frameworks: Next.js, FastAPI");
    expect(output).toContain("Package Manager: pnpm");
    expect(output).toContain("CI/CD: GitHub Actions");
    expect(output).toContain("Docker: yes");
    expect(output).toContain("Has .gitignore");
    expect(output).toContain("README (untrusted): # My App");
  });

  it("omits absent optional fields", () => {
    const result = {
      languages: ["Go"],
      frameworks: [],
      packageManagers: [],
      ciCd: [],
      hasDocker: false,
      hasGitignore: false,
    };

    const output = formatProjectContext(result);
    expect(output).toContain("Languages: Go");
    expect(output).not.toContain("Frameworks:");
    expect(output).not.toContain("Package Manager:");
    expect(output).not.toContain("Docker:");
    expect(output).not.toContain(".gitignore");
  });

  it("respects maxChars option and appends ellipsis", () => {
    const result = {
      projectName: "x".repeat(200),
      description: "y".repeat(200),
      languages: ["TypeScript"],
      frameworks: ["React"],
      packageManagers: ["npm"],
      ciCd: [],
      hasDocker: false,
      hasGitignore: false,
    };

    const output = formatProjectContext(result, { maxChars: 100 });
    expect(output.length).toBeLessThanOrEqual(103);
    expect(output.endsWith("...")).toBe(true);
  });

  it("shows dependency trailing ellipsis only when more than 10 deps are present", () => {
    const deps = Array.from({ length: 10 }, (_, i) => `dep-${i}`);
    const result = {
      languages: ["TypeScript"],
      frameworks: [],
      packageManagers: [],
      dependencies: deps,
      ciCd: [],
      hasDocker: false,
      hasGitignore: false,
    };

    const output = formatProjectContext(result);
    expect(output).not.toContain("...");

    expect(formatProjectContext({ ...result, dependencies: [...deps, "dep-10"] })).toContain("...");
  });
});
