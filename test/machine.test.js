import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { dotnetRootFor, toolchainProblem } from '../src/machine.js'

test('an MSVC toolchain, or none reported, is fine; GNU is not', () => {
  assert.equal(toolchainProblem('stable-x86_64-pc-windows-msvc (overridden by ...)'), undefined)
  assert.equal(toolchainProblem(undefined), undefined)
  assert.match(toolchainProblem('stable-x86_64-pc-windows-gnu (default)'), /^Rust uses stable-x86_64-pc-windows-gnu; Tauri needs MSVC/)
})

test('DOTNET_ROOT is needed for a per-user .NET, not a machine-wide one', () => {
  assert.equal(dotnetRootFor(join('C:', 'Program Files', 'dotnet', 'dotnet.exe')), undefined)
  assert.equal(dotnetRootFor(join('C:', 'tools', 'dotnet', 'dotnet.exe')), join('C:', 'tools', 'dotnet'))
  assert.equal(dotnetRootFor(undefined), undefined)
})
