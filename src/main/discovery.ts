import { promises as fs, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { expand, jsonFile } from './storage'
import type { Installation, Preferences } from '../shared/contracts'

async function executable(path: string) { return fs.access(path, constants.X_OK).then(() => true).catch(() => false) }
export async function searchPaths(): Promise<string[]> {
  const home = homedir()
  const paths = [...(process.env.PATH || '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', join(home, '.local/bin'), join(home, '.npm-global/bin'), join(home, '.volta/bin'), join(home, '.bun/bin'), join(home, '.local/share/mise/shims')]
  for (const root of [join(home, '.nvm/versions/node'), join(home, '.local/share/fnm/node-versions')]) {
    const versions = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    for (const version of versions.filter(v => v.isDirectory()).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))) paths.push(join(root, version.name, root.includes('fnm') ? 'installation/bin' : 'bin'))
  }
  return [...new Set(paths.filter(p => p && p.startsWith('/')))]
}
export async function discover(prefs: Preferences): Promise<Installation[]> {
  const paths = await searchPaths()
  const nodes = [prefs.node, ...paths.map(p => join(p, 'node'))].filter(Boolean)
  let node = ''
  for (const candidate of nodes) if (await executable(candidate)) { node = candidate; break }
  const candidates = [prefs.executable, ...paths.map(p => join(p, 'pi'))].filter(Boolean)
  const found: Installation[] = [], seen = new Set<string>()
  for (const candidate of candidates) {
    const path = expand(candidate)
    if (!await executable(path)) continue
    const real = await fs.realpath(path).catch(() => path)
    if (seen.has(real)) continue
    seen.add(real)
    let version = ''
    for (let dir = dirname(real), n = 0; n < 5; n++, dir = dirname(dir)) {
      const pkg = await jsonFile(join(dir, 'package.json'))
      if (pkg.name === '@earendil-works/pi-coding-agent' || pkg.name === '@mariozechner/pi-coding-agent') { version = String(pkg.version || ''); break }
    }
    const [major, minor, patch] = version.split('.').map(Number)
    const compatible = Boolean(version && (major > 0 || minor > 85 || (minor === 85 && patch >= 1)))
    found.push({ executable: path, node, version: version || '未识别', compatible })
  }
  return found
}
export async function invocation(installation: Installation) {
  const real = await fs.realpath(installation.executable)
  // Published npm entrypoints use a Node shebang; launch them with the detected Node directly.
  const handle = await fs.open(real, 'r')
  let head: string
  try { const buffer = Buffer.alloc(160); const { bytesRead } = await handle.read(buffer, 0, 160, 0); head = buffer.subarray(0, bytesRead).toString('utf8') } finally { await handle.close() }
  if (/^#![^\n]*\bnode\b/.test(head) || /\.[cm]?js$/.test(real)) {
    if (!installation.node) throw new Error('找到了 Pi，但没有找到 Node.js。请在设置中指定 Node.js。')
    return { file: installation.node, prefix: [real] }
  }
  return { file: installation.executable, prefix: [] }
}
