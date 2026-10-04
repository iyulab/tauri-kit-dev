// The restored graph of a .NET project, brought up to date first.
//
// `project.assets.json` is what a restore resolved — not what the project now declares. After a
// branch switch or a pin change it still describes the previous restore until something restores
// again, and a reader that trusts it reports packages the project no longer uses, without a word.
// Its timestamp cannot tell: a restore with nothing to do leaves the file as it was, so a project
// file touched without a package change would look stale forever. Only the restore knows whether
// its inputs changed, so the readers ask it — the way `cargo metadata` resolves before it answers.
// With nothing to do it is a quick no-op and needs no network.
//
// The graph depends on how the project is restored, not only on what it declares: a helper
// published with `-r win-x64 --self-contained` on the command line ships the runtime packs of its
// frameworks, which only a restore for that runtime identifier, self-contained, downloads. A restore
// without those properties reads a graph the shipped helper was not built from, so the properties
// the helper is published with are passed to the restore as well.

import { execFileSync } from 'node:child_process'

/**
 * Restores `project` and returns its `project.assets.json` — where the project itself puts it
 * (`ProjectAssetsFile`), not a guessed `obj/` path.
 *
 * @param {string} project a project file (`.csproj` and the like)
 * @param {Record<string, string | boolean>} [properties] MSBuild global properties for the restore,
 *   as the helper is published — `{ RuntimeIdentifier: 'win-x64', SelfContained: true }` for a
 *   `dotnet publish -r win-x64 --self-contained`
 * @returns {string} the path of the restored assets file
 */
export function restoreAssets(project, properties = {}) {
  let out
  try {
    const props = Object.entries(properties).map(([name, value]) => `-p:${name}=${value}`)
    out = execFileSync('dotnet', ['msbuild', project, '-t:Restore', ...props, '-getProperty:ProjectAssetsFile', '-nologo'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('dotnet is not on PATH — the .NET SDK is needed to restore the project')
    const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split(/\r?\n/).slice(-20).join('\n')
    throw new Error(`restoring ${project} failed${detail ? `:\n${detail}` : ''}`)
  }
  const assets = out.trim().split(/\r?\n/).pop()?.trim()
  if (!assets) throw new Error(`restoring ${project} did not say where its assets file is`)
  return assets
}
