import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { findWindowsCommand } = require('../../../electron/cli-path.cjs') as {
  findWindowsCommand: (bin: string, envPath: string, pathExt?: string) => Promise<string | null>
}

test('Windows CLI lookup preserves a Unicode PATH entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-cli-path-'))
  try {
    const unicodeDir = join(root, '工具目录')
    const otherDir = join(root, 'other')
    await mkdir(unicodeDir)
    await mkdir(otherDir)
    const command = join(unicodeDir, 'qwen.CMD')
    await writeFile(command, '@echo off\r\n')

    const envPath = [otherDir, `"${unicodeDir}"`].join(delimiter)
    assert.equal(await findWindowsCommand('qwen', envPath, '.CMD;.EXE'), command)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
