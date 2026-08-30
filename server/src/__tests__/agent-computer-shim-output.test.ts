/**
 * The BYOA `cumora` shim must hand the engine the WHOLE CLI result.
 *
 * stdout on a pipe is asynchronous in Node, so `process.exit()` on the line
 * after `process.stdout.write()` discards whatever is still buffered. The engine
 * always runs the shim with stdout piped, so this silently truncated every large
 * result at the pipe buffer — with exit code 0 and empty stderr, which is why
 * nothing ever surfaced it.
 *
 * These run the REAL shim text against a REAL pipe, since that is the only place
 * the bug exists.
 *
 * Run: node --import tsx --test server/src/__tests__/agent-computer-shim-output.test.ts
 */

import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { promisify } from 'node:util'
import {
  CUMORA_MCP_SHIM,
  CUMORA_SHIM,
  CUMORA_WINDOWS_SHIM,
  engineProcessPath,
  prependAgentBinToPath,
  RuntimeCliBroker,
  writeShim,
} from '../agents/computer/daemon.js'

const execFileP = promisify(execFile)

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

/** Write the real shim to disk and run it with stdout on a PIPE — the way the
 *  engine's bash tool always invokes it. */
async function runShim(
  payload: string,
  cliExitCode = 0,
): Promise<{ stdoutBytes: number; exitCode: number; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cumora-shim-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const shim = join(dir, 'cumora.js')
  const ipcDir = join(dir, 'ipc')
  await writeFile(shim, CUMORA_SHIM, 'utf8')
  await chmod(shim, 0o755)
  const broker = new RuntimeCliBroker(ipcDir, join(dir, 'broker'), async () => ({ text: payload, exitCode: cliExitCode }))
  await broker.start()
  cleanup.push(() => broker.stop())

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [shim, 'inbox'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CUMORA_AGENT_IPC_DIR: ipcDir,
      },
    })
    let stdoutBytes = 0
    let stderr = ''
    child.stdout.on('data', (b: Buffer) => { stdoutBytes += b.length })
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
    child.on('close', (code) => resolve({ stdoutBytes, exitCode: code ?? -1, stderr }))
  })
}

test('the shim writes the whole CLI payload before exiting', async () => {
  // 1MB cannot fit any pipe buffer, so this is deterministic — there is no size
  // at which the old write-then-exit accidentally passed.
  const payload = 'x'.repeat(1_000_000)
  const r = await runShim(payload)
  assert.equal(
    r.stdoutBytes, payload.length + 1,
    'stdout must carry the full text plus its trailing newline, not just the pipe buffer',
  )
  assert.equal(r.exitCode, 0)
  assert.equal(r.stderr, '')
})

test('a small payload still round-trips unchanged', async () => {
  const payload = 'no unread messages'
  const r = await runShim(payload)
  assert.equal(r.stdoutBytes, payload.length + 1)
  assert.equal(r.exitCode, 0)
})

test('the CLI exit code still propagates, with a large payload', async () => {
  // The exit code must survive being moved into the write callback.
  const payload = 'y'.repeat(300_000)
  const r = await runShim(payload, 2)
  assert.equal(r.stdoutBytes, payload.length + 1)
  assert.equal(r.exitCode, 2, 'a non-zero CLI exit code must still reach the engine')
})

test('an empty payload exits without writing', async () => {
  const r = await runShim('', 1)
  assert.equal(r.stdoutBytes, 0)
  assert.equal(r.exitCode, 1)
})

test('agent bin is prepended with the platform PATH delimiter', () => {
  const inherited = ['first', 'second'].join(delimiter)
  assert.equal(
    prependAgentBinToPath('agent-bin', inherited),
    ['agent-bin', 'first', 'second'].join(delimiter),
  )
  assert.equal(prependAgentBinToPath('agent-bin', ''), 'agent-bin')
})

test('secure engine PATH cannot select a model-planted engine shadow', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-shadow-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const trustedBin = join(root, 'trusted-bin')
  const agentBin = join(root, 'agent-home', 'bin')
  await mkdir(trustedBin, { recursive: true })
  await mkdir(agentBin, { recursive: true })
  await writeFile(join(trustedBin, 'claude'), '#!/bin/sh\necho trusted-engine\n', 'utf8')
  await writeFile(join(agentBin, 'claude'), '#!/bin/sh\necho model-shadow\n', 'utf8')
  await chmod(join(trustedBin, 'claude'), 0o755)
  await chmod(join(agentBin, 'claude'), 0o755)

  const insecureInheritedPath = ['.', agentBin, '', trustedBin].join(delimiter)
  const securePath = engineProcessPath(agentBin, insecureInheritedPath, false)
  assert.equal(securePath, trustedBin)
  assert.equal((await execFileP('claude', [], { env: { PATH: securePath } })).stdout.trim(), 'trusted-engine')

  const compatibilityPath = engineProcessPath(agentBin, trustedBin, true)
  assert.equal((await execFileP('claude', [], { env: { PATH: compatibilityPath } })).stdout.trim(), 'model-shadow')
})

test('writeShim emits a Windows command launcher beside the shared Node shim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cumora-windows-shim-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))

  await writeShim(dir, 'win32')

  assert.equal(await readFile(join(dir, 'cumora'), 'utf8'), CUMORA_SHIM)
  assert.equal(await readFile(join(dir, 'cumora-mcp'), 'utf8'), CUMORA_MCP_SHIM)
  assert.equal(await readFile(join(dir, 'cumora.cmd'), 'utf8'), CUMORA_WINDOWS_SHIM)
})

test('writeShim atomically replaces final symlinks without writing their targets', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-shim-symlink-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const binDir = join(root, 'bin')
  const outside = join(root, 'outside-secret')
  await mkdir(binDir)
  await writeFile(outside, 'do not overwrite', 'utf8')
  await symlink(outside, join(binDir, 'cumora'))

  await writeShim(binDir)

  assert.equal(await readFile(outside, 'utf8'), 'do not overwrite')
  assert.equal((await lstat(join(binDir, 'cumora'))).isSymbolicLink(), false)
  assert.equal(await readFile(join(binDir, 'cumora'), 'utf8'), CUMORA_SHIM)
})

test('writeShim rejects a linked shim directory', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-shim-dir-symlink-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const outside = join(root, 'outside')
  const linked = join(root, 'linked')
  await mkdir(outside)
  await symlink(outside, linked)

  await assert.rejects(writeShim(linked), /refuses linked shim directory/)
})

test('the shim contains neither an HTTP client nor runtime-token handling', () => {
  assert.doesNotMatch(CUMORA_SHIM, /CUMORA_AGENT_RUNTIME_(?:URL|TOKEN)/)
  assert.doesNotMatch(CUMORA_SHIM, /Authorization|Bearer|fetch\s*\(/)
  assert.match(CUMORA_SHIM, /CUMORA_AGENT_IPC_DIR/)
})

test('the restricted Claude MCP bridge exposes only argv and rejects local-body flags', { timeout: 5_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cumora-mcp-shim-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const binDir = join(dir, 'bin')
  const ipcDir = join(dir, 'ipc')
  const brokerDir = join(dir, 'broker')
  const calls: string[][] = []
  const broker = new RuntimeCliBroker(ipcDir, brokerDir, async (argv) => {
    calls.push(argv)
    return { text: 'ok from daemon', exitCode: 0 }
  })
  await broker.start()
  cleanup.push(() => broker.stop())
  await writeShim(binDir)

  const child = spawn(process.execPath, [join(binDir, 'cumora-mcp')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CUMORA_AGENT_IPC_DIR: ipcDir },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
  child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cli', arguments: { argv: ['inbox'] } } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'cli', arguments: { argv: ['reply', 'c1', '--file', '/host/secret'] } } })}\n`)
  child.stdin.end()

  await new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`MCP bridge exited ${code}: ${stderr}`)))
  })
  const responses = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
    id: number
    result?: { tools?: Array<{ name?: string }>; content?: Array<{ text?: string }>; isError?: boolean }
  })
  const byId = new Map(responses.map((entry) => [entry.id, entry]))
  assert.deepEqual(calls, [['inbox']])
  assert.equal(byId.get(2)?.result?.tools?.[0]?.name, 'cli')
  assert.equal(byId.get(3)?.result?.content?.[0]?.text, 'ok from daemon')
  assert.equal(byId.get(3)?.result?.isError, false)
  assert.equal(byId.get(4)?.result?.isError, true)
  assert.match(byId.get(4)?.result?.content?.[0]?.text ?? '', /local file\/stdin flags are unavailable/)
})

test('the privileged IPC broker refuses model-created request symlinks', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cumora-ipc-symlink-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const ipcDir = join(dir, 'ipc')
  let invoked = false
  const broker = new RuntimeCliBroker(ipcDir, join(dir, 'broker'), async () => {
    invoked = true
    return { text: 'should not run', exitCode: 0 }
  })
  await broker.start()
  cleanup.push(() => broker.stop())

  const target = join(dir, 'outside.json')
  const id = '12345678-1234-1234-1234-123456789abc'
  await writeFile(target, JSON.stringify({ argv: ['inbox'] }), 'utf8')
  await symlink(target, join(ipcDir, 'requests', `${id}.json`))
  await broker.poll()

  assert.equal(invoked, false)
  const response = JSON.parse(await readFile(join(ipcDir, 'responses', `${id}.json`), 'utf8')) as { exitCode?: number; error?: string }
  assert.equal(response.exitCode, 70)
  assert.match(response.error ?? '', /regular file|symbolic link|too many levels/i)
})

test('the IPC broker coalesces a trigger storm while preserving one pending rerun', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cumora-ipc-coalesce-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const ipcDir = join(dir, 'ipc')
  const calls: string[][] = []
  let firstInvocationStarted!: () => void
  const started = new Promise<void>((resolve) => { firstInvocationStarted = resolve })
  let releaseFirstInvocation!: () => void
  const blocked = new Promise<void>((resolve) => { releaseFirstInvocation = resolve })
  const broker = new RuntimeCliBroker(ipcDir, join(dir, 'broker'), async (argv) => {
    calls.push(argv)
    if (calls.length === 1) {
      firstInvocationStarted()
      await blocked
    }
    return { text: 'ok', exitCode: 0 }
  })
  await broker.start()
  cleanup.push(() => broker.stop())

  const firstId = '12345678-1234-1234-1234-123456789abe'
  await writeFile(join(ipcDir, 'requests', `${firstId}.json`), JSON.stringify({ argv: ['first'] }), 'utf8')
  const activeDrain = broker.poll()
  await started

  const secondId = '12345678-1234-1234-1234-123456789abf'
  await writeFile(join(ipcDir, 'requests', `${secondId}.json`), JSON.stringify({ argv: ['second'] }), 'utf8')
  const storm = Array.from({ length: 2_000 }, () => broker.poll())
  assert.ok(storm.every((pending) => pending === activeDrain), 'all triggers must share one bounded drain')

  releaseFirstInvocation()
  await Promise.all(storm)
  assert.deepEqual(calls, [['first'], ['second']])
})

test('a response publication failure is logged inside the broker drain, not rejected in the background', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cumora-ipc-response-failure-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const ipcDir = join(dir, 'ipc')
  let invoked = false
  const broker = new RuntimeCliBroker(ipcDir, join(dir, 'broker'), async () => {
    invoked = true
    return { text: 'ok', exitCode: 0 }
  })
  await broker.start()
  cleanup.push(() => broker.stop())

  const id = '12345678-1234-1234-1234-123456789ac0'
  const responsePath = join(ipcDir, 'responses', `${id}.json`)
  await mkdir(responsePath)
  await writeFile(join(ipcDir, 'requests', `${id}.json`), JSON.stringify({ argv: ['inbox'] }), 'utf8')

  await assert.doesNotReject(broker.poll())
  assert.equal(invoked, true)
  assert.equal((await lstat(responsePath)).isDirectory(), true)
})

test('stopping the IPC broker aborts an in-flight daemon call and suppresses its response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cumora-ipc-stop-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const ipcDir = join(dir, 'ipc')
  let invocationStarted!: () => void
  const started = new Promise<void>((resolve) => { invocationStarted = resolve })
  let receivedAbort = false
  const broker = new RuntimeCliBroker(ipcDir, join(dir, 'broker'), async (_argv, signal) => {
    invocationStarted()
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => resolve(), { once: true })
    })
    receivedAbort = signal.aborted
    return { text: 'must not be published', exitCode: 0 }
  })
  await broker.start()
  cleanup.push(() => broker.stop())
  const id = '12345678-1234-1234-1234-123456789abd'
  await writeFile(join(ipcDir, 'requests', `${id}.json`), JSON.stringify({ argv: ['inbox'] }), 'utf8')
  const poll = broker.poll()
  await started
  broker.stop()
  await poll

  assert.equal(receivedAbort, true)
  await assert.rejects(readFile(join(ipcDir, 'responses', `${id}.json`), 'utf8'), { code: 'ENOENT' })
})

test('PowerShell resolves cumora from the injected PATH and forwards arguments', {
  skip: process.platform !== 'win32',
}, async () => {
  let receivedArgv: string[] | undefined
  const dir = await mkdtemp(join(tmpdir(), 'cumora-powershell-shim-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const ipcDir = join(dir, 'ipc')
  const broker = new RuntimeCliBroker(ipcDir, join(dir, 'broker'), async (argv) => {
    receivedArgv = argv
    return { text: 'sent from test', exitCode: 0 }
  })
  await broker.start()
  cleanup.push(() => broker.stop())
  await writeShim(dir)

  const { stdout, stderr } = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', "cumora reply direct-test 'hello from windows'"],
    {
      env: {
        ...process.env,
        PATH: prependAgentBinToPath(dir),
        CUMORA_AGENT_IPC_DIR: ipcDir,
      },
    },
  )

  assert.equal(stdout.trim(), 'sent from test')
  assert.equal(stderr, '')
  assert.deepEqual(receivedArgv, ['reply', 'direct-test', 'hello from windows'])
})
