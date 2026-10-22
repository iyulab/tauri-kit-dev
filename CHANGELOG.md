# Changelog

## [Unreleased]

### Added

- `App.endpoint`: where the launched window's debugging port answers, for another CDP client to drive the same window — Playwright's `connectOverCDP`, for one (README, «Another driver on the same window»).

### Changed

- `docs/SCOPE.md`: admission test 4 reads a request as a sample of every app with the same cause; the number of apps that asked is no longer the test, and an unclear case is settled by asking the caller rather than waiting for more callers.

## [0.11.1] - 2026-10-22

### Fixed

- `withInstalled` (and `walkUpdate`, which installs through it) no longer leaves the product's
  install location pointing at the removed temporary folder. An NSIS installer records the folder it
  installed into as the default value of `HKCU\Software\<maker>\<product>`, its uninstaller leaves
  that value, and the next install without `/D` — a person's, or a release walk's — went into the
  removed folder. The value is now put back as it was before the install (the value it held, no
  value, or no key), and a value put back that names a folder that does not exist is warned about.
  The pieces: `softwareKeys`, `parseSoftwareKeys`, `installLocationRestores`, `restoreCommand`.

## [0.11.0] - 2026-10-20

### Added

- `walkUpdate` (`installer`): walks the update an installed copy takes on its own — installs the
  previous published release into a temporary folder, starts it, waits until its `tauri-kit-update`
  state says the newest release is found and its installer ready, has it install (by default by
  closing its main window), and answers each step: the new version installed in the same folder, the
  app not started again (or started, with `restarts`), the kept installer let go of on the next launch.
  It refuses to run while the product is installed, since the walk's copy takes over the user's
  uninstall entry. With the pieces it uses: `pickUpdateWalk`, `readUpdateState`, `updateReady`,
  `installedVersion`, `processesIn` and `closeMainWindow`.

## [0.10.1] - 2026-10-20

### Fixed

- `App.click` counts a press as landed only when its click reaches the element. A control the page turned off between
  the press going down and coming up gets no click, and was counted as pressed — the scenario then waited for what the
  click should have opened; it is now tried again like any other missed press. An element the press took away before
  its click (a menu item that acts as the press goes down) still counts as pressed, and a click that falls on whatever
  lay under it is kept from the page.

## [0.10.0] - 2026-10-17

### Added

- `versions --config <file> [--bump <x.y.z>]` (and `checkVersions` · `bumpVersions` from `/versions`): checks that every
  file an app writes its version in holds the same one — `Cargo.toml` (`[package]` or `[workspace.package]`), the
  app's own entry in `Cargo.lock`, `tauri.conf.json`, `package.json`, both places in `package-lock.json`, a .NET
  project's `<Version>` — naming the file that differs, and with `--bump` writes the new version into all of them,
  each in place. A file whose version cannot be found leaves every file as it was.
- `pin-drift --npm <package.json> --cargo <Cargo.toml> --repository <pattern>` (and `checkRegistryDrift` from
  `/registry-drift`): the npm packages and crates an app declares are judged as its NuGet pins are — against the newest
  stable version on npm and crates.io, failing on a major difference or more than `--max-minor-gap` minor versions
  behind unless a waiver covers it. Which packages count is their repository on the registry, matched against
  `--repository` — not a list of names. The NuGet options are now optional; the sources can be given together.
  `judgeDrift` (from `/pin-drift`) is the one judgment both use.
- `App.launchDev({ cwd, command = 'npx tauri dev', … })`: drives the app the way it is developed — the command run in
  `cwd` through a shell, its window waited for as `launch` waits for a built one (10 minutes by default, for the first
  build) — and `quit` ends everything the command started, not only the shell (`endTree`).
- `leftovers` (in `launch` and `launchDev`) and `endLeftovers(names)`: the executables a run given up on may have left
  running are ended before the app starts — only the names given (Windows).
- `readDiscovery(path)`: a helper's discovery file, read as soon as it is there and whole.
- `telemetry --app <resource> --resource-group <group> [--days <n>] [--version <x.y.z>]` (and `readTelemetry` from
  `/telemetry`): for each version, how often it was started, on how many installations, how many sessions it left
  unfinished and how many failures it reported, read from the Application Insights resource tauri-kit-diagnostics sends
  to, as the person signed in to the Azure CLI. `--version` fails when that version has not been started anywhere.

### Fixed

- `public-text`: on a local branch with no upstream, only the commits no remote-tracking branch holds are checked
  for their messages — before, every commit back to the first was, so a new branch made from a pushed one failed
  on messages that were already public. A detached HEAD (how CI checks a commit out) still counts every commit.

## [0.9.0] - 2026-10-14

### Added

- `runScenarios({ scenarioTimeoutMs })`: a scenario that has not finished within the time (default 5 minutes)
  fails with `did not finish within <n> s`, and the run goes on to quit the window. What a failure gathers — what
  the window showed, its picture — is bounded too (15 s, or the scenario time when shorter).

### Fixed

- A scenario waiting on a step with no deadline of its own — a protocol command a window that stopped answering
  never answers — held the run until something outside ended it, and the run said nothing about which scenario
  it was in.

## [0.8.0] - 2026-10-13

### Added

- `Cdp.send(method, params, { timeoutMs })` and `Cdp.evaluate(expression, { timeoutMs })`: a command the window
  has not answered within the time fails with `<method>: no answer within <n> s` instead of waiting on. Without
  `timeoutMs` a command waits as before.

### Fixed

- `Cdp.waitFor` kept waiting past its deadline when one evaluation never answered — a page whose script hangs
  keeps the command pending while the debugging connection stays open. Each evaluation is now bounded by the time
  left, so `waitFor` fails at its deadline with `timed out waiting for …`.
- A run that ended without `App.quit` — an error thrown past its `finally`, `process.exit`, or Ctrl+C on a run
  that hung — left the app's window running, and the next launch met it. `App.launch` now ends the app when the
  process exits or is interrupted, until `quit` ends it first; on Ctrl+C with no other `SIGINT` handler the
  process then exits with 130, as it would have.
- `Cdp.close` fails the commands still waiting for an answer at once, rather than when the window lets the
  connection go — which a hung window may never do.

## [0.7.0] - 2026-10-10

### Fixed

- `App.launch` said only "no page on debugging port … (fetch failed)" when a window never opened its
  debugging port, a minute after the window had appeared. It now reads the command lines of the
  WebView2 browsers on the computer and says which it was: no browser was started for the app, or one
  was started without `--remote-debugging-port` — the runtime did not apply
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` — with where the remedy is. New `debugPortDiagnosis(port,
  exeName, commandLines)` (`app`) makes that call from the command lines alone.
- The README and `debugEnv` said the environment variable opens the port. Current WebView2 runtimes
  do not apply it to an app that passes browser arguments of its own, which a Tauri app always does.
  The README now has *Opening the debugging port*: forwarding the variable from the debug build into
  the window's browser arguments, or a test configuration with a fixed port — and the web view
  library's default arguments both must repeat.

## [0.6.4] - 2026-10-08

### Added

- `withAppDataSetAside(appData, body)` (`installer`): runs a check with the app's data folder moved
  aside and puts it back afterwards, passed or not, removing what the check's app wrote. An installed
  copy started by a check writes where the person's own copy does, and one ended by force leaves an
  unfinished session there for the next real launch to find or send. It refuses to run while a folder
  set aside by an earlier, interrupted check is still there.

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
