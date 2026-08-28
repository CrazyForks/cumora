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
  // npm installs both a POSIX shell shim (`bin`) and a Windows command shim
  // (`bin.cmd`). The extensionless file is not executable by CreateProcess,
  // so honour PATHEXT before falling back to a literal filename.
  const names = path.extname(bin) ? [bin] : [...extensions.map((ext) => `${bin}${ext}`), bin]

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

/** Build a spawn target for a command resolved on Windows. CreateProcess
 * cannot execute .cmd/.bat files directly; run those through ComSpec while
 * leaving native executables alone. */
function windowsCommandInvocation(command, args, comspec = process.env.ComSpec || 'cmd.exe') {
  if (!/\.(?:cmd|bat)$/i.test(command)) return { command, args }
  const commandArgs = args.map((arg) => {
    const value = String(arg)
    return /^[\w./:=+-]+$/u.test(value) ? value : `"${value.replace(/"/g, '""')}"`
  })
  // With windowsVerbatimArguments, the doubled leading quote is the outer
  // `cmd /c` quote followed by the executable-path quote. The final quote
  // closes that outer pair. This is required when the shim path has spaces.
  const commandLine = `""${command}"${commandArgs.length ? ` ${commandArgs.join(' ')}` : ''}"`
  return {
    command: comspec,
    args: ['/d', '/s', '/c', commandLine],
    windowsVerbatimArguments: true,
  }
}

module.exports = { findWindowsCommand, windowsCommandInvocation }
