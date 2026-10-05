import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Shell invocation is platform-sensitive: the same command string crosses a
// POSIX login shell on macOS/Linux and cmd.exe on Windows. Everything the
// plugin pipes through `shBig` (base64 / wc / tail / printf / unlink / /tmp)
// only exists on the POSIX side.
const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

test('shell: the platform comes from the backend, and the PATH hint is added only on POSIX', () => {
  // A `PATH=/opt/homebrew/...:$PATH gh` prefix is a VARIABLE NAMES assignment
  // under cmd.exe: gh never runs and the call "succeeds" with empty stdout, which
  // is worse than a visible failure. shell.exec runs on the BACKEND (the remote
  // host over SSH), so the shell is probed there, never guessed from the client.
  assert.ok(source.includes("const GH = 'gh'"), 'GH must be a bare name')
  assert.ok(source.includes("const HERMES = 'hermes'"), 'HERMES must be a bare name')
  assert.ok(!source.includes('const POSIX_SHELL ='), 'client-side platform guess must not decide the shell')
  assert.ok(source.includes("command: 'echo %OS%'"), 'backend shell probe is missing')
  assert.ok(source.includes('return POSIX_PATH_HINT + cmd'), 'POSIX commands must get the PATH hint in shellCommand')
})

test('shell: every shell.exec goes through the shellCommand wrapper', () => {
  // A raw `host.request('shell.exec', { command: cmd })` call site bypasses the
  // Windows bash hop and reintroduces the cmd.exe bug for that one query.
  const calls = source.match(/host\.request\('shell\.exec', \{ command: [^}]*\}/g) || []
  assert.ok(calls.length >= 4, 'expected the wrapper callers, the shell probes and the bash probe')
  for (const call of calls) {
    const ok =
      call.includes('shellCommand(') ||
      call.includes("'where git'") ||
      call.includes("'echo %OS%'") ||
      call.includes('if exist')
    assert.ok(ok, `unwrapped shell.exec call site: ${call}`)
  }
  // cmd.exe parses the whole command string (no \" handling; |>&^% are live), so user
  // text may only cross it as base64; bash decodes to a $$-unique script and runs it.
  assert.ok(!source.includes('echo ${cmd}'), 'raw command text must not cross cmd.exe')
  assert.ok(
    source.includes('| base64 -d > /tmp/gt$$.sh; bash /tmp/gt$$.sh; e=$?; unlink /tmp/gt$$.sh; exit $e'),
    'Windows commands must decode from base64 inside bash with per-invocation state',
  )
})

test('shell: Windows routes through Git bash, not WSL bash', () => {
  // Windows ships WSL's bash.exe in System32; invoking it would run the command
  // against a different filesystem with no `gh` on PATH. Resolve bash from the
  // installed Git instead of trusting PATH.
  assert.ok(source.includes('function resolveBash'), 'resolveBash is missing')
  assert.ok(source.includes('command: \'where git\''), 'bash must be derived from the git install')
  assert.ok(source.includes("git.replace(/\\\\/g, '/')"), 'Windows paths must be normalized before parsing')
  assert.ok(source.includes('(?:cmd|mingw64\\/bin|usr\\/bin)'), 'all Git-for-Windows install layouts must resolve')
  assert.ok(source.includes('bin\\\\bash.exe'), 'expected Git-for-Windows bash candidates')
  assert.ok(!/const BASH = '[A-Z]:/.test(source), 'bash path must not be hardcoded to a drive letter')
  // The first command must wait for the Git-for-Windows probe; it must never
  // race into bare `bash` and accidentally launch System32's WSL shim.
  assert.ok(source.includes('let bashReady = null'), 'bash resolution must be shared')
  assert.ok(source.includes('await resolveBash()'), 'shell commands must await bash resolution')
  assert.ok(source.includes("Git for Windows bash.exe was not found"), 'missing Git Bash needs a clear recovery error')
})

test('shell: bash is resolved once at registration', () => {
  const register = source.slice(source.indexOf('register(ctx) {'))
  assert.ok(register.includes('resolveBash()'), 'register must start bash resolution')
})

test('shell: shBig only uses coreutils Git-for-Windows bash actually ships', () => {
  // shBig runs inside the msys2 bash hop on Windows, so every binary it invokes
  // must exist there. `od` is POSIX coreutils and ships alongside the `wc` /
  // `tail` / `tr` / `unlink` this pipeline already relied on. `xxd` does NOT
  // ship in every Git-for-Windows layout, which is why the hex encode is `od`.
  const big = source.slice(source.indexOf('async function shBig'), source.indexOf('async function shJsonBig'))
  const bigCode = big.replace(/\/\/.*$/gm, '') // assert on code, not on the prose explaining it
  assert.ok(bigCode.includes('od -An -v -tx1'), 'hex encode must use POSIX od')
  assert.ok(!/\bxxd\b/.test(bigCode), 'xxd is not guaranteed present in Git-for-Windows')
  assert.ok(!/\bbase64\b/.test(bigCode), 'base64 output collides with the gateway JWT redactor')
  // The cmd.exe length guard is computed on the base64 of the WHOLE wrapped
  // command; the shBig wrapper plus the list --jq projections must stay far
  // under it (measured: ~540 b64 chars for the largest, guard is 6000).
  assert.ok(source.includes('if (b64.length > 6000)'), 'cmd.exe length guard must stay')
})
