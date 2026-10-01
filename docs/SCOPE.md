# Scope

tauri-kit-dev holds the tools a Tauri desktop app needs while it is being built and checked —
driving its window in end-to-end runs, checking its installer, checking the machine it is built
on, keeping its public text clean. This document draws the line around that job: what
tauri-kit-dev owns, what it deliberately leaves to its callers, and how to tell which side a
proposed tool falls on.

It exists because tauri-kit-dev is a **shared core**. More than one app builds on it, and those
apps do not know about each other. Without a written boundary, each app's needs would accrete here
one reasonable-looking commit at a time, until the tools served every caller badly.

---

## The layer tauri-kit-dev owns

**Development and verification of a Tauri desktop app, outside the app.** Nothing here is
bundled into an app or runs on a user's computer as part of one. Within that:

- **Driving the window** — a Chrome DevTools Protocol client for the WebView2 window (or any
  Chromium page with a debugging port), and the launch, wait, screenshot and teardown around it
- **Checking an installer** — installing silently into a temporary folder, starting what was
  installed, installing over a published version, installing on a clean machine (Windows
  Sandbox), uninstalling
- **Checking the build machine** — the toolchain and runtime prerequisites a Tauri build or a
  bundled helper process needs, checked before a long build rather than discovered during it
- **Checking public text** — finding text a public repository must not carry, against a list the
  caller supplies
- **Release hygiene** — checks that run before publishing: versions that must agree, notices for
  third-party code, provenance of bundled helper binaries

If a Tauri app's development is worse *as development* without it, and the tool can be written
without knowing which app it serves, it probably belongs here.

## What tauri-kit-dev does not do

Each of these is a deliberate non-goal, not a gap awaiting a contribution:

- **Ship inside an app.** Runtime capabilities — file writes, helper processes, credentials,
  diagnostics an installed app sends — belong in the runtime crates (`tauri-kit`), not here.
- **Know its callers.** No code path, option, default, comment, test fixture or commit message
  assumes a particular consuming app. See *Dependency direction* below.
- **Hold a caller's constants.** Executable names, ports, bundle identifiers, environment variable
  names, data folder names, files an installer must carry, the expression that says a window is
  ready — all arrive as arguments. A default is acceptable only when it is true of Tauri apps in
  general.
- **Hold a caller's lists.** The names a caller keeps out of its public text are the caller's; a
  list committed here would publish them.
- **Write scenarios.** What a window should do when clicked is the app's test, written with these
  tools. Finding an element by the app's own labels or component names is the app's business.
- **Build or publish.** Running `tauri build`, signing and releasing are the app's pipeline (or
  the organisation's reusable workflows); the tools here check what a build produced.

## Dependency direction

**Upstream does not know downstream.** tauri-kit-dev must not reference any consuming app by
name — not in code, not in comments, not in documentation, not in commit messages, not in test
fixtures. Two consumers must remain mutually invisible through it.

When a comment needs to say why an option exists, describe the *situation* it serves ("an app
whose installer bundles a helper process"), never the app.

---

## Is this request in scope?

Work through these in order. The first one that answers settles it.

**1. Does it run outside the app?** A tool that would ship to users is a runtime capability, out
of scope here regardless of the rest.

**2. Does it serve developing or checking a Tauri app?** A general-purpose utility that happens to
be handy is not enough; the need should come from building, testing or releasing such an app.

**3. Can it be stated without naming a caller?** Write the tool down without naming any app or its
domain. If the description needs "for X" to make sense, it is that caller's concern. Every
constant it needs becomes a parameter; if the parameters are the whole tool, it is the caller's.

**4. Would a second, unrelated app want it?** Not "could it be justified?" but "does the need
arise naturally for someone else?" A tool already written separately by two apps answers this
question; a hypothetical second app does not.

### When the answer is no

Out of scope is not the same as unimportant. A tool that fails these tests usually belongs to
the app, composed around what is here.

### When the answer is genuinely unclear

Prefer the narrower reading. A tool withheld can be added once a second app shows the same need;
a tool released becomes a contract.
