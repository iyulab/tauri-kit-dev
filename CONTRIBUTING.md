# Contributing

## Before proposing a tool: read the scope

tauri-kit-dev is a **shared core** — more than one app builds on it, and those apps do not know
about each other. **[docs/SCOPE.md](docs/SCOPE.md) is the gate**: it states what belongs here,
what deliberately does not, and a numbered test for deciding which side a request falls on.
Include that reasoning in your proposal.

Two rules come up often enough to repeat:

- **No consuming app is named** — in code, comments, documentation, test fixtures or commit
  messages. Describe the situation a tool serves, never the app that has it.
- **Constants are parameters.** An executable name, a port, a bundle identifier, an environment
  variable prefix: the caller passes it.

## Checking your own names before you contribute

`npm run guard` checks this repository against rules that name no one: local paths, private
hosts, and the traces a private workspace tends to leave behind. It cannot check for *your*
app's names without listing them here. Before pushing, run the same check with your own list,
kept outside this repository:

```sh
npx tauri-kit-dev public-text --config <your private config> .
```

## Development

The package is plain ES modules run directly by Node — there is no build step.

```sh
npm test        # node --test
npm run guard   # this repository's own public-text check
```

Both run in CI and must pass. Tools that only run on Windows (installers, Windows Sandbox) keep
their decisions — argument parsing, generated files, parsing of what they read back — in
functions that the tests can call on any platform.

## Conventions

- **Language** — everything in this repository is written in English.
- **Tests** — behaviour changes come with tests.
- **Changelog** — user-visible changes get an entry in [CHANGELOG.md](CHANGELOG.md) under
  `## [Unreleased]`.
- **Versioning** — while the version is `0.x`, a minor bump may break the API; a patch bump does
  not.
