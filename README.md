# tauri-kit-dev

Development and verification tools for desktop apps made with [Tauri](https://tauri.app) — the
scripts most such apps end up writing for themselves to drive their window in end-to-end runs,
check their installers and keep their public repositories clean. Nothing here ships inside an
app; for runtime building blocks, see [tauri-kit](https://github.com/iyulab/tauri-kit).

```sh
npm install --save-dev @iyulab/tauri-kit-dev
```

Requires Node 22.4 or later. What it gives an app, and what it deliberately leaves to the app, is
in [docs/SCOPE.md](docs/SCOPE.md).

## Driving the window over CDP

WebView2 opens a Chrome DevTools Protocol port when the app starts with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` (or the equivalent in the
app's own window configuration for a test build).

```js
import { writeFile } from 'node:fs/promises'
import { Cdp, findPage } from '@iyulab/tauri-kit-dev/cdp'

const page = await findPage(9222)
const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
await cdp.waitFor(`document.readyState === 'complete'`, 'the page')
await cdp.evaluate(`document.querySelector('input').focus()`)
await cdp.insertText('hello')
await writeFile('window.png', await cdp.screenshot())
cdp.close()
```

`portAnswers(port)` tells whether something is already listening — a window left over from an
earlier run would otherwise answer in place of the one just started.

## Running scenarios against the app

```js
import { App, runScenarios } from '@iyulab/tauri-kit-dev/app'

const options = {
  exe: 'target/debug/my-app.exe',
  port: 9224,
  ready: `!!document.querySelector('my-app')`, // when the window counts as ready is the app's to say
}

process.exitCode = await runScenarios(
  {
    'opens the settings': async (app) => {
      await app.click('button', 'Settings')
      await app.cdp.waitFor(`__e2e.one('h1', 'Settings')`, 'the settings page')
    },
    'saves a name': async (app) => {
      await app.fill('input[aria-label="Name"]', 'Ada')
      await app.cdp.press('Enter')
    },
  },
  { start: async () => ({ app: await App.launch(options) }) },
)
```

Scenarios run in order against one window, each building on what the last left. `--through
<part of a name>` stops after the first scenario whose name contains it and `--repeat <n>` runs
that many times, each from a fresh start — for a scenario that fails only sometimes.
`E2E_SCREENSHOTS=<dir>` saves a picture after each scenario, and of the window when one fails.

The window under test reads its bundled resources from the copies a build leaves next to the
executable (`target/<profile>/…`), and the build copies files in but never removes one: a file
deleted from the source, or left there by a build of another branch, is still read by the
scenarios. Removing the copy before the build makes it the source's again — in `src-tauri/build.rs`,
for a resource directory bundled as `assets`:

```rust
fn main() {
    // Watch the source directory so that a file removed from it runs this again.
    println!("cargo:rerun-if-changed=../assets");
    // OUT_DIR is target/<profile>/build/<crate>-<hash>/out; three levels up is the profile directory.
    if let Some(profile) = std::env::var_os("OUT_DIR").as_deref().map(std::path::Path::new).and_then(|out| out.ancestors().nth(3)) {
        let _ = std::fs::remove_dir_all(profile.join("assets"));
    }
    tauri_build::build()
}
```

## Checking the installer

```js
import { join } from 'node:path'
import { findInstaller, startsAndStays, withInstalled } from '@iyulab/tauri-kit-dev/installer'

const installer = findInstaller('target/release/bundle/nsis', { version: '1.2.0' })
await withInstalled(installer, async (target) => {
  // installed silently for the current user into a temporary folder
  if (!(await startsAndStays(join(target, 'my-app.exe')))) throw new Error('the installed app did not stay up')
}, { exe: 'my-app.exe' }) // uninstalled afterwards, and checked to be gone
```

Installing over the latest published version (`pickUpgradeFrom`, `downloadInstaller`) and checking
that WebView2 profile copies are dropped (`profileSnapshots`, `seedProfileSnapshot`) use the same
pieces.

On a computer without internet, in Windows Sandbox:

```sh
npx tauri-kit-dev sandbox <installer> --exe my-app.exe [--extra checks.ps1] [--without-webview2]
```

The script inside records each step and writes a result the command reads back; `--extra` adds
the app's own steps (`Step '<name>' { ... }`, with `$target` the install folder). Windows Sandbox
is an optional Windows feature (Containers-DisposableClientVM).

## Checking the build machine

```sh
npx tauri-kit-dev machine [--dotnet]
```

On Windows, the Rust toolchain must be MSVC; with `--dotnet`, a per-user .NET install needs
`DOTNET_ROOT` for a bundled .NET helper process.

## Checking public text

```sh
npx tauri-kit-dev public-text [--config <file>] [--history] [<repo>...]
```

Checks each git repository (default: the current one) — tracked files, and the messages of
commits not yet pushed — for local paths and private hosts. `--history` also reads every commit
message, every line any commit ever added and tag messages: old versions of files stay readable
once a repository is public.

`--config` names a module with the caller's own rules. Keep it out of the repository it checks:
a list of the names to keep out of a public repository, committed there, publishes them.

```js
// public-text.config.js
export default {
  forbidden: [{ why: 'internal name', re: /\bproject-codename\b/i }],
  allowed: ['.gitignore:notes/'], // `path:text` substrings known to be fine
  // defaults: false,             // drop the built-in local-path and private-host rules
}
```

A line that is meant to carry what a rule finds — a test whose subject is a home folder — says so
on that line or the one above it, so the exception sits next to its reason:

```js
// public-text: allow — the test is about paths under a home folder
const home = 'C:\Users\someone\notes'
```

The same check is available as a function:

```js
import { checkRepo, loadConfig } from '@iyulab/tauri-kit-dev/public-text'

const findings = checkRepo('.', { config: await loadConfig('public-text.config.js'), history: true })
```

## Versioning

While the version is `0.x`, a minor bump may break the API; a patch bump does not.
[CHANGELOG.md](CHANGELOG.md) lists what each release changed.

## License

[MIT](LICENSE)
