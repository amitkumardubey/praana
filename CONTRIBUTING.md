# Contributing to PRAANA

PRAANA is open source under the [MIT license](./LICENSE). You can use it, read it, fork it and build on it freely.

**We don't accept external pull requests.** The project is developed by its maintainers, which keeps the design consistent and lets us ship fixes quickly. That doesn't mean we don't want to hear from you. Feedback from people who use PRAANA shapes what we build next.

## How you can help

- **Report a bug.** Use the [bug report form](https://github.com/amitkumardubey/praana/issues/new?template=bug_report.yml). The most useful reports include your PRAANA version (`praana --version`), your operating system, what you expected, and the steps to reproduce it.
- **Suggest a feature.** Share the problem you are trying to solve in [Discussions → Ideas](https://github.com/amitkumardubey/praana/discussions/categories/ideas). A clear description of the problem helps us more than a proposed implementation.
- **Ask a question.** Use [Discussions → Q&A](https://github.com/amitkumardubey/praana/discussions/categories/q-a) for usage help and configuration questions.
- **Report a security problem privately.** Please don't open a public issue. Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a vulnerability**.
- **Spread the word.** A star, a post or a recommendation to a colleague helps more people find PRAANA.

We read every issue and discussion. We may close requests that don't fit the project's direction, and we'll say why when we do.

## Build it yourself

You're welcome to fork the project, experiment, and run your own changes locally.

```bash
git clone https://github.com/amitkumardubey/praana.git
cd praana
bun install
bun typecheck
bun test
```

PRAANA requires [Bun](https://bun.sh/install) 1.4 or newer. `bun dev` runs it without a build step.

[AGENTS.md](./AGENTS.md) describes the architecture, conventions and common pitfalls if you want to understand how the code is organised.

## License

PRAANA is released under the [MIT license](./LICENSE).
