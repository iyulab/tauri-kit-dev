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
