# Contributing to PRAANA

Thanks for your interest in PRAANA. This project is experimental — issues, docs fixes, and small features are especially welcome.

## Quick start

```bash
git clone https://github.com/amitkumardubey/praana.git
cd praana
npm install
npm run build
npm test
```

Requires **Node 22+**.

## Development workflow

1. **Find or open an issue** — check [open issues](https://github.com/amitkumardubey/praana/issues). Issues labeled [`good first issue`](https://github.com/amitkumardubey/praana/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are scoped for first-time contributors.
2. **Branch from `main`** — use conventional branch names: `feat/issue-123-short-desc`, `fix/issue-456-bug-name`.
3. **Write or update tests** — add coverage in `tests/` for new logic. Use in-memory SQLite (`:memory:`) for memory-layer tests.
4. **Run the suite** — `npm run build && npm test` must pass before you open a PR.
5. **Open a pull request** — link the issue (`Closes #123`), describe what changed and why.

## Code conventions

- **TypeScript strict mode**, ES2022, NodeNext imports with `.js` extensions (`import { foo } from "./bar.js"`).
- **Files:** `kebab-case.ts`. **Functions/vars:** `camelCase`. **Types:** `PascalCase`.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- Match the style of surrounding code. No Prettier/ESLint config — keep diffs focused.
- Don't edit `CHANGELOG.md` by hand; release-please generates it from commit messages.

See [AGENTS.md](./AGENTS.md) for architecture, memory systems, and common gotchas.

## Where to contribute

| Area | Entry points |
|------|----------------|
| TUI | `src/ui/tui/` |
| Memory | `src/memory/`, `tests/memory*.test.ts` |
| Context engine | `src/context-engine/`, `tests/context-engine*.test.ts` |
| Tools | `src/tools/` |
| Docs | `README.md`, `docs/`, `website/` (Astro GitHub Pages), `ROADMAP.md` |

## Reporting bugs

Use the [bug report template](https://github.com/amitkumardubey/praana/issues/new?template=bug_report.yml). Include PRAANA version (`praana --version` or `npm list -g praana`), Node version, OS, and steps to reproduce.

## Feature ideas

Open a [feature request](https://github.com/amitkumardubey/praana/issues/new?template=feature_request.yml) or start a thread in [Discussions → Ideas](https://github.com/amitkumardubey/praana/discussions/categories/ideas).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
