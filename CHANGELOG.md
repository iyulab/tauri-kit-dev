# Changelog

## [Unreleased]

## [0.4.0] - 2026-10-03

### Added

- `notices` command: `tauri-kit-dev notices --config <file> [--strict] [--check]` writes an app's
  third-party notices from a config naming its npm lockfile, crate folder and target, restored
  NuGet assets and pinned texts (paths relative to the config). A pin that applies to no shipped
  package or a pinned text that is not the pinned one fails; `--strict` also fails on a package
  without a license text; `--check` compares instead of writing. The config's `render(packages)`
  replaces the default document. An app no longer assembles the readers, the pins and these rules
  in a script of its own. The assembly is exported as `shippedNotices(sources)`.
- `app`: `runScenarios` takes `--only <part of a name>` — just the scenarios whose names contain
  it, in order, without those before them — for scenarios that stand on their own, such as
  measurements. `--through` and `--only` together are an error.

### Changed

- `app`: `runScenarios` keeps the picture of a failed scenario even without `E2E_SCREENSHOTS`, in a
  new folder under the temp folder (the `failures` option names another), and logs where — an
  intermittent failure can be read after the run.

### Documentation

- README: a development build keeps reading a bundled resource file after it is removed from the
  source (the build copies resources next to the executable and never removes a copy), so window
  scenarios can run against files the source no longer has; a `build.rs` that removes the copy
  first keeps them in step.

## [0.3.1] - 2026-10-02

### Fixed

- `installer`: `downloadInstaller` takes the installer of the tag's version when the release also
  carries a copy of it under a name without the version (a link that always reaches the latest
  installer). Both ended like the pattern, so it found two and failed. The choice is exported as
  `pickReleaseInstaller(files, { tag, pattern })`.

## [0.3.0] - 2026-10-02

### Added

- `public-text`: a line marked `public-text: allow` — on the line itself or the line just above it,
  best followed by why — is left out of the findings, in tracked files and, with `--history`, in
  added lines. The exception sits next to the fixture it is for instead of in a `path:text` list
  kept elsewhere. `ALLOW_MARK` and `markedAllowed(lines, index)` are exported.

### Fixed

- `installer`: `run` quotes the program's own path. Run verbatim (NSIS takes `/D=` unquoted), a path
  with a space was cut there and NSIS read the rest as options — a folder named `rt` as `/R`, which
  starts the app once installed, leaving a second copy running beside the one a check starts.
- `installer`: `withInstalled` hands the body the temporary folder's long form. A runner's temporary
  folder can come in its 8.3 form (`RUNNER~1`), which compares unequal to the paths running processes
  report.

## [0.2.0] - 2026-10-01

### Fixed

- `public-text` checks files whose path holds characters outside ASCII. git quoted those paths in its
  file list, the quoted form named no file, and they were skipped without a word.
- `App.fill` replaces what an editable element (`contenteditable`) holds, as it does an input's value;
  it used to type after it.
- `App.launch` constructs the class it is called on, so an app's own subclass of `App` (with its own
  steps — open a document, pick a tab) launches and restarts as that subclass.
- `notices`: `cargoPackages` leaves out the other members of the package's workspace as well as the
  package itself — they are the app's own code, not third-party packages.

### Added

- `notices`: every reader also returns `texts`, the license texts the package itself carries
  (LICENSE, LICENSE-MIT, COPYING, NOTICE and the like, or the file a nuspec names) — from the crate's
  folder, the installed npm package (`installedAt`), or the NuGet package folder. Most permissive
  licenses make keeping that text, copyright line included, the condition itself, so an identifier
  alone does not meet them. `withoutText(packages)` lists the packages that carry none, for a gate to
  stop on; `noticesText(packages, { title })` renders a plain-text document with every text, printing
  a text several packages share word for word once and referring to it from the others;
  `licenseTexts(dir)` reads a folder's texts.
- `notices`: pinned license texts, for a package that publishes without its text.
  `applyPinned(packages, { pins, dir })` fills such packages in from committed files, keyed
  `name@version` in a pins JSON of `{ source, sha256 }` — or a list of them, for a license whose
  conditions span several files (Apache-2.0's NOTICE) — and checks every digest (taken with CRLF
  read as LF, so a checkout that converts line endings still matches) — no network, so a
  check gives the same answer everywhere. It reports the pins that applied to nothing (a moved
  version, a package now carrying its own text) and the ones that could not be applied (file
  missing, digest differs); a filled package gets `textSource`, which `noticesText` prints.
  `fetchPinned({ pins, dir })` and `tauri-kit-dev notice-pins --pins <file> --dir <dir>` download the
  texts, record the SHA-256 of a pin given only its source, and refuse a source that no longer
  matches its pin.

- `App.launch({ webviewProfile })` and `webviewGone(profile)`: `quit` also waits until the app's WebView2
  processes — found by the identifier in their command line — have exited, ending leftovers after a
  grace period. A window started while the last one's browser is still shutting down on the same
  profile never opens its debugging port; the port going quiet comes before that.
- `@iyulab/tauri-kit-dev/provenance`: say which source a built helper was made from, so checks
  that run it test what they mean to. `gitSourceState(cwd, folder)` gives a folder's committed tree,
  the commit, and a digest of anything uncommitted in it (`pendingDigest`); `filesDigest` and
  `filesUnder` digest an installed payload wherever it lives. `writeStamp`/`readStamp` keep a flat
  JSON record the app shapes, and `judgeStamp(record, { digestKey, digest, expected })` answers
  `unknown` (no stamp, or the output is not the one stamped), `match` or `differs` — a field an
  older stamp never recorded never matches.
- `@iyulab/tauri-kit-dev/pin-drift` and `tauri-kit-dev pin-drift`: NuGet pins of one publisher's
  packages in a `Directory.Packages.props`, against the newest versions on nuget.org. Which
  packages count is read from the restored graph — those whose own nuspec names the publisher among
  its authors. A major difference, or more minor versions behind than allowed (default 5), fails
  unless a waiver with an unexpired date covers it; a waiver without an expiry is refused, and one
  no longer needed is reported. The publisher's packages that arrive only transitively are held to
  the same threshold, and a pinned package whose own floor on another of them lags far behind is
  noted.
- `@iyulab/tauri-kit-dev/notices`: third-party notices from the dependency graphs that ship.
  `cargoPackages({ cwd, target })` reads the normal-dependency closure of a Rust binary for one
  target (build- and dev-dependencies left out); `npmPackages({ lock, installedAt })` the
  production closure in an npm lockfile, filling a missing license and the upstream link from
  installed manifests unless `installedAt` is `null`; `nugetPackages({ assets })` the packages of a
  restored .NET project that put runtime or native assets into the build, licensed from their
  nuspecs. Each returns `{ name, version, license, url }`. `needsReview(packages, accepted)` screens
  SPDX expressions against the caller's accepted set (`PERMISSIVE` to start from — reading
  `MIT/Apache-2.0` as two identifiers); `noticesTable` renders a Markdown table; `writeOrCheck`
  regenerates the file or, with `check`, reports whether the committed one is stale.
- `@iyulab/tauri-kit-dev/gate` and `tauri-kit-dev gate --config <file>`: run an app's checks in
  order the way a merge gate does, but locally and to the end — every step runs even after one
  fails, then a summary lists each step's result and time. Steps are named shell commands; a
  `local` step is one CI does not run, and a step with `optIn: '--flag'` runs only when that flag
  is given (or the step is named), for a pre-release gate that adds slow steps around the merge
  steps. `--list`, `--only a,b` and `--skip c` choose steps; an unknown name is an error.
  `preflight(selected)` can refuse to start with a message, for a failure the app can see coming
  that a step's own output would not explain. Exit codes: 0 green, 1 failed, 2 did not start.

## [0.1.0] - 2026-10-01

### Added

- `@iyulab/tauri-kit-dev/cdp`: a Chrome DevTools Protocol client for a WebView2 window —
  `findPage`, `portAnswers`, and `Cdp` with `evaluate`, `waitFor`, `insertText`, `press`,
  `clickAt` and `screenshot`. No dependencies; uses Node's built-in WebSocket.
- `@iyulab/tauri-kit-dev/public-text` and `tauri-kit-dev public-text`: checks git repositories for
  local paths, private hosts and a caller-supplied list of forbidden text — in tracked files,
  unpushed commit messages, and with `--history` every commit, every added line and tag messages.
- `@iyulab/tauri-kit-dev/app`: start a debug build with WebView2's debugging port and drive its
  window. `App.launch({ exe, port, ready, env })` refuses a port that already answers (a window an
  earlier run left open would answer in place of the new one), waits for the app's own `ready`
  expression, and installs in-page helpers that query through shadow roots; `click`, `fill`,
  `restart`, `quit`. `quit` waits until the debugging port goes quiet: the WebView2 browser process
  outlives the app's own by a moment, and a restart would otherwise find it. `runScenarios` runs an
  app's scenarios in order against one window, stops at the first failure with what the window
  showed, saves a picture after each scenario (`E2E_SCREENSHOTS`), and takes `--through <name>`
  and `--repeat <n>` for a scenario that fails only sometimes.
- `@iyulab/tauri-kit-dev/installer`: NSIS per-user installer checks — find the installer of a
  version among earlier ones, `withInstalled(installer, body)` (silent install into a temporary
  folder, uninstall and clean up whatever `body` did), `startsAndStays`, `fileVersion`, the newest
  published version to update from (`pickUpgradeFrom`, `publishedReleases`, `downloadInstaller`
  through `gh`), and WebView2 profile snapshot helpers for checking that an update drops the copies
  a runtime update takes.
- `@iyulab/tauri-kit-dev/sandbox` and `tauri-kit-dev sandbox <installer> --exe <file>`: install
  and start the app in Windows Sandbox with networking off, record whether WebView2 was there
  before (registration and files), whether the app started a web view of its own, and run the
  app's own checks from an `--extra` PowerShell script. `--without-webview2` removes the runtime
  inside the sandbox first; `--prepare` only lays out the folder and the `.wsb` file. Arguments
  reach the script in double quotes: `powershell -File` keeps single quotes as part of a value.
- `@iyulab/tauri-kit-dev/machine` and `tauri-kit-dev machine [--dotnet]`: on Windows, the active
  Rust toolchain must be MSVC (the GNU linker fails linking a Tauri app without saying why); with
  `--dotnet`, a per-user .NET install needs `DOTNET_ROOT` for a bundled .NET helper.
