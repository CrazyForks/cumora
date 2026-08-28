const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** Resolve a command without parsing `where.exe` output. `where` writes paths
 *  in the active Windows code page, which corrupts non-ASCII directories when
 *  Electron decodes stdout as UTF-8. Node's filesystem APIs preserve Unicode. */
async function findWindowsCommand(bin, envPath, pathExt = process.env.PATHEXT ?? DEFAULT_WINDOWS_PATHEXT) {
  const extensions = (pathExt || DEFAULT_WINDOWS_PATHEXT)
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => ext.startsWith('.') ? ext : `.${ext}`)
  const names = path.extname(bin) ? [bin] : [bin, ...extensions.map((ext) => `${bin}${ext}`)]

  for (const rawDir of envPath.split(path.delimiter)) {
    const trimmed = rawDir.trim()
    const dir = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if ((await fs.promises.stat(candidate)).isFile()) return candidate
      } catch { /* next candidate */ }
    }
  }
  return null
}

module.exports = { findWindowsCommand }
