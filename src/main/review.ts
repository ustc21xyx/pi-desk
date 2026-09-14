import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import type { ReviewFile, ReviewSnapshot } from '../shared/contracts'

const exec = promisify(execFile)
const limit = 2 * 1024 * 1024
const prefix = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=true']
const cache = new Map<string, { cwd: string; at: number; snapshot: ReviewSnapshot }>()
const locks = new Set<string>()
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
async function git(cwd: string, args: string[]) {
  return (await exec('/usr/bin/git', [...prefix, '-C', cwd, ...args], { timeout: 15000, maxBuffer: limit })).stdout
}
async function section(cwd: string, staged: boolean) {
  const base = ['diff', ...(staged ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--no-relative', '--binary', '--full-index', '--src-prefix=a/', '--dst-prefix=b/']
  const patch = await git(cwd, [...base, '--', '.'])
  const names = (await git(cwd, [...base, '--name-only', '-z', '--', '.'])).split('\0').filter(Boolean)
  const patches = patch.split(/(?=^diff --git )/m).filter(Boolean)
  if (names.length !== patches.length) throw new Error('文件正在变化，请刷新差异。')
  // Re-read to avoid combining names and contents from two different revisions.
  if (patch !== await git(cwd, [...base, '--', '.'])) throw new Error('文件正在变化，请刷新差异。')
  const files: ReviewFile[] = patches.map((patch, index) => {
    const id = hash(patch), parts = patch.split(/(?=^@@ )/m), header = parts.shift() || ''
    const reversible = !/^(?:old mode|new mode|new file mode|deleted file mode|index .* )\s*(?:120000|160000)/m.test(header) && !/^index [^\n]* (?:120000|160000)$/m.test(header)
    const ordinary = reversible && !/^(?:new file mode|deleted file mode|old mode|new mode|GIT binary patch)/m.test(patch)
    return { id, path: names[index], patch: patch.includes('GIT binary patch') ? `${header.split('GIT binary patch')[0]}二进制文件改动\n` : patch, reversible,
      hunks: ordinary ? parts.map(part => ({ id: hash(part), header: part.split('\n')[0], patch: part })) : [] }
  })
  return { staged, files, raw: patches }
}
const rawCache = new Map<string, string[][]>()
export async function readReview(cwd: string): Promise<ReviewSnapshot> {
  try {
    const sections = [await section(cwd, false), await section(cwd, true)]
    const snapshot = { id: randomUUID(), sections: sections.map(({ staged, files }) => ({ staged, files })) }
    for (const [id, value] of cache) if (Date.now() - value.at > 600_000 || cache.size >= 20) { cache.delete(id); rawCache.delete(id) }
    cache.set(snapshot.id, { cwd, at: Date.now(), snapshot }); rawCache.set(snapshot.id, sections.map(s => s.raw))
    return snapshot
  } catch { throw new Error('无法读取 Git 差异。请确认项目是 Git 仓库，差异不超过 2 MB，并在文件停止变化后刷新。') }
}
async function apply(cwd: string, patch: string, staged: boolean, check: boolean) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/git', [...prefix, '-C', cwd, 'apply', '--reverse', '--whitespace=nowarn', ...(staged ? ['--cached'] : []), ...(check ? ['--check'] : []), '-'], { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 15000)
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000) })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(timedOut ? '操作超时，请刷新后检查文件状态。' : `差异无法完整应用，未强行覆盖文件。请刷新后处理冲突。${stderr.includes('index') ? ' 暂存区可能已变化。' : ''}`)) })
    child.stdin.on('error', () => {})
    child.stdin.end(patch)
  })
}
export async function revertReview(cwd: string, snapshotId: string, staged: boolean, fileId?: string, hunkId?: string) {
  const previous = cache.get(snapshotId), raw = rawCache.get(snapshotId)
  if (!previous || !raw || previous.cwd !== cwd || Date.now() - previous.at > 600_000) throw new Error('差异预览已过期，请刷新后重试。')
  const repo = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  if (locks.has(repo)) throw new Error('正在处理这个仓库的改动，请稍候。')
  locks.add(repo)
  try {
    const current = await readReview(cwd)
    const selected = previous.snapshot.sections.find(s => s.staged === staged)!
    if (JSON.stringify(previous.snapshot.sections) !== JSON.stringify(current.sections)) throw new Error('文件或暂存区已变化。请刷新并重新确认撤销范围。')
    if (hunkId && !fileId) throw new Error('请指定代码块所属文件。')
    const chosen = fileId ? selected.files.filter(f => f.id === fileId) : selected.files
    if (!chosen.length || chosen.some(f => !f.reversible)) throw new Error('所选差异为空或包含链接、子模块，请在 Git 中处理。')
    const sectionIndex = staged ? 1 : 0
    const patch = chosen.map(file => {
      const full = raw[sectionIndex][selected.files.indexOf(file)]
      if (!hunkId) return full
      const hunk = file.hunks.find(h => h.id === hunkId)
      if (!hunk) throw new Error('代码块已失效，请刷新差异。')
      return full.split(/^@@ /m)[0] + hunk.patch
    }).join('')
    await apply(repo, patch, staged, true)
    // External editors can change files during confirmation/check; never use --reject or force.
    const checked = await readReview(cwd)
    if (JSON.stringify(current.sections) !== JSON.stringify(checked.sections)) throw new Error('检查期间文件发生变化，请刷新后重试。')
    await apply(repo, patch, staged, false)
    cache.delete(snapshotId); rawCache.delete(snapshotId)
    return await readReview(cwd)
  } finally { locks.delete(repo) }
}
