# Changelog

## [Unreleased]

### Added

- `@iyulab/tauri-kit-dev/gate` and `tauri-kit-dev gate --config <file>`: run an app's checks in
  order the way a merge gate does, but locally and to the end — every step runs even after one
  fails, then a summary lists each step's result and time. Steps are named shell commands; a
  `local` step is one CI does not run, and a step with `optIn: '--flag'` runs only when that flag
  is given (or the step is named), for a pre-release gate that adds slow steps around the merge
  steps. `--list`, `--only a,b` and `--skip c` choose steps; an unknown name is an error.
  `preflight(selected)` can refuse to start with a message, for a failure the app can see coming
  that a step's own output would not explain. Exit codes: 0 green, 1 failed, 2 did not start.
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
