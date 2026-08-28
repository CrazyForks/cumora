import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { findWindowsCommand, windowsCommandInvocation } = require('../../../electron/cli-path.cjs') as {
  findWindowsCommand: (bin: string, envPath: string, pathExt?: string) => Promise<string | null>
  windowsCommandInvocation: (
    command: string,
    args: string[],
    comspec?: string,
  ) => { command: string; args: string[]; windowsVerbatimArguments?: boolean }
}

test('Windows CLI lookup preserves a Unicode PATH entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-cli-path-'))
  try {
    const unicodeDir = join(root, '工具目录')
    const otherDir = join(root, 'other')
    await mkdir(unicodeDir)
    await mkdir(otherDir)
    await writeFile(join(unicodeDir, 'qwen'), '#!/bin/sh\n')
    const command = join(unicodeDir, 'qwen.CMD')
    await writeFile(command, '@echo off\r\n')

    const envPath = [otherDir, `"${unicodeDir}"`].join(delimiter)
    assert.equal(await findWindowsCommand('qwen', envPath, '.CMD;.EXE'), command)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows command invocation uses ComSpec for command shims', () => {
  const comspec = String.raw`C:\Windows\System32\cmd.exe`
  const command = String.raw`C:\工具 目录\qwen.cmd`
  assert.deepEqual(windowsCommandInvocation(command, ['--version'], comspec), {
    command: comspec,
    args: ['/d', '/s', '/c', `""${command}" --version"`],
    windowsVerbatimArguments: true,
  })
  assert.deepEqual(windowsCommandInvocation(String.raw`C:\tools\qwen.exe`, ['--version'], comspec), {
    command: String.raw`C:\tools\qwen.exe`,
    args: ['--version'],
  })
})

test('Windows command invocation runs a shim in a Unicode path', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-cli-version-'))
  try {
    const unicodeDir = join(root, '工具 目录')
    await mkdir(unicodeDir)
    const command = join(unicodeDir, 'qwen.cmd')
    await writeFile(command, '@echo off\r\necho qwen-code 1.2.3\r\n')
    const invocation = windowsCommandInvocation(command, ['--version'])
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
      })
      let text = ''
      child.stdout.on('data', (chunk) => { text += chunk.toString('utf8') })
      child.stderr.on('data', (chunk) => { text += chunk.toString('utf8') })
      child.on('error', reject)
      child.on('close', (code) => code === 0 ? resolve(text.trim()) : reject(new Error(`exit ${code}: ${text}`)))
    })
    assert.equal(output, 'qwen-code 1.2.3')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
