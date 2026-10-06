# Changelog

## [Unreleased]

## [0.6.3] - 2026-10-06

### Fixed

- `App.click` could lose a click without a word: the page could move the element, or turn it off, in
  the moment between the check that it is clickable and the press arriving, and the press then went to
  whatever was there (or to nothing). The helpers now watch the press itself: one that does not land on
  the element, still enabled, is kept from what it hit and the click is tried again — up to `attempts`
  times (default 5, `click(selector, text, { attempts })`) with a line on the console each time, then it
  fails saying so. New in-page helpers `arm(el)` and `disarm()`.

## [0.6.2] - 2026-10-05

### Fixed

- `App.quit` (with `webviewProfile`) failed with "did not exit" on a machine whose cores were all busy:
  WebView2 processes ended by force were given 5 s to go, and their teardown took 13–17 s there.
  `webviewGone` now gives them 60 s (`killMs` to change it), and watches them from one PowerShell per
  wait rather than starting one every quarter second, which added load to the machine it waited on.

### Changed

- `notices` and `nugetPackages` fail when the NuGet properties say self-contained (`SelfContained` or
  `PublishAot`) and the restore downloaded no runtime pack — the helper ships a runtime, and notices
  without it were left to pass silently (as when a restore was run without the runtime identifier).

## [0.6.1] - 2026-10-05

### Fixed

- `notices` left out the .NET runtime packs of a helper published with `-r <rid> --self-contained` on
  the command line (since 0.6.0): the project is restored without those properties, and such a
  restore downloads no runtime pack. The restore now takes the properties the helper is published
  with — config `nuget: { project, properties: { RuntimeIdentifier: 'win-x64', SelfContained: true } }`,
  `pin-drift --properties "RuntimeIdentifier=win-x64"`, and `properties` on `nugetPackages`,
  `checkPinDrift` and `restoreAssets`.

## [0.6.0] - 2026-10-04

### Changed

- **Breaking**: `notices` and `pin-drift` take the .NET project, not its `project.assets.json`, and
  restore it before reading — config `nuget: { project: '<file>.csproj' }` instead of
  `nuget: { assets }`, `pin-drift --project <file>` instead of `--assets <file>`;
  `nugetPackages({ project, restore? })` and `checkPinDrift({ project, restore?, … })` likewise. A
  config that still names `nuget.assets` is an error that says so. Needs the .NET SDK on PATH (a
  restore with nothing to do takes under a second and no network).

### Fixed

- `notices` and `pin-drift` read whatever the last restore left: after a branch switch or a pin
  change, before anything restored again, the notices named the previous branch's package versions
  (and `--check` then failed the right file as stale), with no message saying why. The assets file's
  timestamp cannot tell — a restore with nothing to do leaves it untouched — so the project is now
  restored first, the way `cargo metadata` resolves before it answers.

## [0.5.1] - 2026-10-03

### Fixed

- `notices`: a package that carries the notices of the code it bundles (`THIRD-PARTY-NOTICES`) but
  not its own license file counted as having its license text, so its license was left out and the
  pin that supplied it failed as applying to no shipped package. The bundled notices are now kept
  apart, as `bundledNotices`, and never stand in for the package's license: the package is listed by
  `withoutText` until a pin fills it in, and the document prints its license before the notices.
  `licenseTexts(dir)` returns the package's own license files only; `bundledNotices(dir)` returns the
  bundled notices.

## [0.5.0] - 2026-10-03

### Added

- `notice-pins --config <file>` (the notices config) looks up a pin for every shipped package still
  without a license text — its license file in its source at the version that shipped — adds what
  it found to the config's pins, fetches them, and names the packages it found nothing for. The
  commit a package was published from is used when its published form records one (a crate's
  `.cargo_vcs_info.json`, a nuspec's `repository commit`, an npm manifest's `gitHead`), with the
  package's own folder in the repository tried before the root; otherwise its release tags. A branch
  is never tried, and a package already pinned is not looked up again — a pinned text that fails
  stays a failure. GitHub sources only. Exported as `suggestPins(packages)`; the readers return the
  recorded commit and folder as `vcs`.

### Fixed

- `notices`: a .NET helper published self-contained or ahead of time ships the runtime of each
  framework it references, and its notices left that out — the restore records the runtime packs
  (`Microsoft.NETCore.App.Runtime.<rid>`, `Microsoft.AspNetCore.App.Runtime.<rid>`, the
  `NativeAOT` pack) apart from the project's packages. `nugetPackages` now includes the runtime packs
  of the frameworks the project references; a pack of a framework it does not reference, and the
  ahead-of-time compiler, stay out.
- `notices`: a package's notices for the third-party code it bundles (`THIRD-PARTY-NOTICES`,
  `ThirdPartyNotices`) are among its texts, after its license — that code ships inside the
  package's files. The .NET runtime packs carry theirs this way.
- `notices --check` (`writeOrCheck`) reads CRLF as LF, as the pinned-text digests already do — a
  checkout that converts line endings (git's autocrlf on Windows) no longer reads as stale.

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
