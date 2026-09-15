import { promises as fs } from 'node:fs'
import { relative, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const ignored = new Set(['.git', 'node_modules', '.DS_Store', '.next', 'dist', 'out', 'release', 'vendor'])
const cache = new Map<string, { at: number; paths: string[]; truncated: boolean }>()
const pending = new Map<string, Promise<{ paths: string[]; truncated: boolean }>>()
const safe = (p: string) => !!p && !/[\x00-\x1f\x7f"\\]/.test(p) && !p.split('/').some(part => ignored.has(part) || part === '..') && !p.startsWith('/')
async function index(root: string) {
  const known = cache.get(root)
  if (known && Date.now() - known.at < 15_000) return known
  if (pending.has(root)) return pending.get(root)!
  const job = (async () => {
    let paths: string[] = [], truncated = false
    try {
      const { stdout } = await exec('/usr/bin/git', ['--no-pager', '-c', 'core.fsmonitor=false', '-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { timeout: 4000, maxBuffer: 2 * 1024 * 1024 })
      paths = [...new Set(stdout.split('\0').filter(safe))]
      truncated = paths.length > 8000; paths = paths.slice(0, 8000)
    } catch {
      const dirs = [root]; let visited = 0
      const deadline = Date.now() + 2000
      while (dirs.length && paths.length < 8000 && visited < 20000 && Date.now() < deadline) {
        const dir = dirs.shift()!
        const entries = await fs.opendir(dir).catch(() => undefined)
        if (!entries) continue
        for await (const entry of entries) {
          if (++visited > 20000 || paths.length >= 8000 || Date.now() >= deadline) { truncated = true; break }
          const path = relative(root, join(dir, entry.name))
          if (!safe(path) || entry.isSymbolicLink()) continue
          if (entry.isDirectory()) dirs.push(join(root, path))
          else if (entry.isFile()) paths.push(path)
        }
      }
      truncated ||= dirs.length > 0
    }
    paths.sort((a, b) => a.localeCompare(b))
    if (cache.size >= 8) cache.delete(cache.keys().next().value!)
    cache.set(root, { at: Date.now(), paths, truncated })
    return { paths, truncated }
  })().finally(() => pending.delete(root))
  pending.set(root, job); return job
}
export async function fileReferences(root: string, query: string) {
  const result = await index(root), parts = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const matches = result.paths.filter(path => parts.every(p => path.toLocaleLowerCase().includes(p)))
  matches.sort((a, b) => Number(!a.split('/').at(-1)!.toLocaleLowerCase().startsWith(query.toLocaleLowerCase())) - Number(!b.split('/').at(-1)!.toLocaleLowerCase().startsWith(query.toLocaleLowerCase())))
  return { paths: matches.slice(0, 8), truncated: result.truncated || matches.length > 8 }
}
