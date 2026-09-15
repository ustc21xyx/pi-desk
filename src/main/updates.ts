import { app, net, session, type Session } from 'electron'
import { Readable } from 'node:stream'
import { promises as fs, createReadStream } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { UpdateState } from '../shared/contracts'

const exec = promisify(execFile)
const repository = 'ustc21xyx/pi-desk'
const maxDownload = 512 * 1024 * 1024
type Asset = { name: string; url: string; size: number; digest: string }
class UpdateError extends Error {}
function updateErrorMessage(error: unknown) {
  if (error instanceof UpdateError) return error.message
  const value = error as { message?: unknown; name?: unknown; code?: unknown; cause?: { code?: unknown } } | undefined
  const message = typeof value?.message === 'string' ? value.message : ''
  const rawCode = value?.cause?.code || value?.code
  const code = message.match(/\bnet::(ERR_[A-Z_]{1,70})\b/)?.[1] || (typeof rawCode === 'string' && /^(ERR_[A-Z_]{1,70}|EACCES|EPERM|ENOSPC|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND)$/.test(rawCode) ? rawCode : undefined)
  if (value?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'ERR_TIMED_OUT') return '更新请求超时，请稍后重试。'
  if (value?.name === 'AbortError') return '更新请求已中断，请重试。'
  if (code === 'ENOSPC') return '磁盘空间不足，无法保存更新包。'
  if (code === 'EACCES' || code === 'EPERM') return '没有权限写入更新文件，请检查应用数据目录权限。'
  if (code?.includes('PROXY') || code === 'ERR_TUNNEL_CONNECTION_FAILED') return `系统代理连接失败（${code}），请检查代理连接。`
  if (code?.includes('CERT') || code?.includes('SSL')) return `更新服务器的安全连接失败（${code}），请检查系统时间和代理证书。`
  if (code) return `更新连接失败（${code}），请检查网络或系统代理。`
  if (message === 'Redirect was cancelled') return '更新地址跳转被中断，请重新下载或使用本地安装包。'
  if (error instanceof SyntaxError) return '更新服务器返回的版本信息无法解析，请稍后重试。'
  return '更新请求发生未识别异常，请重试或使用本地安装包。'
}
let updateNetwork: Promise<Session> | undefined
function network() {
  return updateNetwork ||= (async () => {
    const isolated = session.fromPartition('pi-desk-updates', { cache: false })
    await isolated.setProxy({ mode: 'system' })
    return isolated
  })().catch(error => { updateNetwork = undefined; throw error })
}
function newer(candidate: string, current: string) {
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number)
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i] }
  return false
}
async function hashFile(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
function updateURL(url: string) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname)) throw new UpdateError('更新地址无效。')
  return parsed
}
// Electron fetch does not expose a manual redirect response. Use ClientRequest's
// synchronous redirect event to validate each destination before following it.
async function request(url: string, signal: AbortSignal): Promise<Response> {
  const parsed = updateURL(url), isolated = await network()
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const client = net.request({ url: parsed.href, method: 'GET', session: isolated, redirect: 'manual', credentials: 'omit', useSessionCookies: false, cache: 'no-store', bypassCustomProtocolHandlers: true })
    let redirects = 0
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => { cleanup(); reject(signal.reason); client.abort() }
    signal.addEventListener('abort', abort, { once: true })
    // ClientRequest is a Writable: its close can precede the response. Keep
    // cancellation attached until the response stream closes or the request fails.
    client.on('error', error => { cleanup(); reject(error) })
    client.on('redirect', (_status, method, destination) => {
      try {
        updateURL(destination)
        if (method !== 'GET' || ++redirects > 4) throw new UpdateError('更新下载跳转异常，已停止请求。')
        client.followRedirect()
      } catch (error) { cleanup(); reject(error); client.abort() }
    })
    client.on('response', response => {
      const stream = response as unknown as Readable
      stream.once('close', cleanup)
      try {
        const headers = new Headers()
        for (const [key, value] of Object.entries(response.headers)) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        const body = [204, 205, 304].includes(response.statusCode) ? null : Readable.toWeb(stream) as ReadableStream<Uint8Array>
        resolve(new Response(body, { headers, status: response.statusCode, statusText: response.statusMessage }))
      } catch (error) { cleanup(); reject(error); client.abort() }
    })
    client.setHeader('User-Agent', 'Pi-Desk-Updater')
    client.setHeader('Accept', parsed.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream')
    if (signal.aborted) abort()
    else client.end()
  })
}

export class AppUpdates {
  state: UpdateState = { currentVersion: app.getVersion(), phase: 'idle', supported: app.isPackaged && process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch) }
  private asset?: Asset
  private download?: string
  private workspace?: string
  private working = false
  private downloadController?: AbortController
  private downloadCancelled = false
  constructor(private publish: (state: UpdateState) => void) {}
  private emit(patch: Partial<UpdateState>) { this.state = { ...this.state, ...patch }; this.publish({ ...this.state }); return this.state }
  private error(error: unknown) { return this.emit({ phase: 'error', error: updateErrorMessage(error) }) }
  async check() {
    if (this.working || this.state.phase === 'installing') return this.state
    this.working = true
    this.emit({ phase: 'checking', error: undefined, version: undefined, notes: undefined, progress: undefined, transferStage: undefined, receivedBytes: undefined, totalBytes: undefined, bytesPerSecond: undefined })
    this.asset = undefined; this.download = undefined
    try {
      const response = await request(`https://api.github.com/repos/${repository}/releases/latest`, AbortSignal.timeout(25_000))
      if (response.status === 404) return this.emit({ phase: 'current', notes: '还没有已发布的安装包。' })
      if (response.status === 403 || response.status === 429) throw new UpdateError('GitHub 暂时限制了更新检查，请稍后重试。')
      if (!response.ok || !response.body) throw new UpdateError(`无法读取更新信息（HTTP ${response.status}），请稍后重试。`)
      const chunks: Uint8Array[] = []; let size = 0
      for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) { size += chunk.length; if (size > 1024 * 1024) throw new UpdateError('更新信息过大。'); chunks.push(chunk) }
      const release = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const match = typeof release.tag_name === 'string' && /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name)
      if (!match || release.draft || release.prerelease) throw new UpdateError('更新版本信息无效。')
      const version = match[1]
      if (!newer(version, this.state.currentVersion)) return this.emit({ phase: 'current' })
      const name = `Pi-Desk-${version}-${process.arch}.dmg`
      const asset = Array.isArray(release.assets) && release.assets.find((a: any) => a.name === name)
      const expectedURL = `https://github.com/${repository}/releases/download/v${version}/${name}`
      if (!asset || asset.browser_download_url !== expectedURL || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxDownload || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) throw new UpdateError('此版本尚无适配这台 Mac 的完整更新包，请稍后再检查。')
      this.asset = { name, url: expectedURL, size: asset.size, digest: asset.digest.slice(7) }
      return this.emit({ phase: 'available', version, notes: typeof release.body === 'string' ? release.body.slice(0, 6000) : '' })
    } catch (error) { return this.error(error) } finally { this.working = false }
  }
  async fetchUpdate() {
    if (this.working || this.state.phase === 'installing') return this.state
    if (!this.state.supported) return this.error(new UpdateError('请在已安装的 macOS 版 Pi Desk 中更新。'))
    if (!this.asset) return this.error(new UpdateError('请先检查更新。'))
    this.working = true
    this.downloadCancelled = false
    const controller = new AbortController()
    this.downloadController = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)])
    let size = 0, lastReceivedAt = Date.now(), sampleAt = Date.now(), sampleSize = 0, emittedAt = 0
    this.emit({ phase: 'downloading', error: undefined, progress: 0, transferStage: 'connecting', receivedBytes: 0, totalBytes: this.asset.size, bytesPerSecond: 0 })
    const timer = setInterval(() => {
      const now = Date.now()
      if (now - lastReceivedAt >= 45_000) controller.abort(new UpdateError('下载连接长时间没有收到数据，请检查系统代理或重试。'))
      if (this.state.transferStage === 'receiving') this.emit({ receivedBytes: size, bytesPerSecond: Math.round((size - sampleSize) * 1000 / Math.max(1, now - sampleAt)) })
      sampleAt = now; sampleSize = size
    }, 1000)
    try {
      if (this.workspace) await fs.rm(this.workspace, { recursive: true, force: true })
      const directory = join(app.getPath('userData'), 'updates')
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      this.workspace = await fs.mkdtemp(join(directory, 'download-'))
      const path = join(this.workspace, this.asset.name)
      const response = await request(this.asset.url, signal)
      if (!response.ok || !response.body) throw new UpdateError(`无法下载更新包（HTTP ${response.status}），请稍后重试。`)
      this.emit({ transferStage: 'receiving' })
      const file = await fs.open(path, 'wx', 0o600), hash = createHash('sha256')
      try {
        for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
          signal.throwIfAborted()
          size += chunk.length
          if (size > this.asset.size) throw new UpdateError('安装包大小不匹配，已停止下载。')
          await file.writeFile(chunk); hash.update(chunk)
          lastReceivedAt = Date.now()
          if (lastReceivedAt - emittedAt >= 250) { emittedAt = lastReceivedAt; this.emit({ progress: size * 100 / this.asset.size, receivedBytes: size }) }
        }
      } finally { await file.close() }
      signal.throwIfAborted()
      clearInterval(timer)
      this.emit({ transferStage: 'verifying', receivedBytes: size })
      if (size !== this.asset.size || hash.digest('hex') !== this.asset.digest) throw new UpdateError('安装包校验失败，请重新下载。')
      this.download = path
      return this.emit({ phase: 'ready', progress: 100, transferStage: undefined, bytesPerSecond: undefined })
    } catch (error) {
      const failure = signal.aborted && signal.reason instanceof Error ? signal.reason : error
      clearInterval(timer)
      controller.abort()
      this.download = undefined
      if (this.workspace) await fs.rm(this.workspace, { recursive: true, force: true }).catch(() => {})
      if (this.downloadCancelled) return this.emit({ phase: 'available', error: undefined, progress: undefined, transferStage: undefined, receivedBytes: undefined, bytesPerSecond: undefined })
      return this.error(failure)
    } finally { clearInterval(timer); this.downloadController = undefined; this.working = false }
  }
  cancelDownload() {
    if (this.state.phase === 'downloading' && this.downloadController) {
      this.downloadCancelled = true
      this.downloadController.abort()
    }
    return this.state
  }
  async stage() {
    if (this.working || this.state.phase !== 'ready' || !this.download || !this.asset || !this.workspace) throw new UpdateError('请先下载更新。')
    // Update the currently installed app only; a mounted DMG or App Translocation is read-only.
    const target = dirname(dirname(dirname(process.execPath)))
    const allowed = ['/Applications/Pi Desk.app', join(app.getPath('home'), 'Applications/Pi Desk.app')]
    if (!allowed.includes(target) || await fs.realpath(target) !== target) throw new UpdateError('请先将 Pi Desk 放入“应用程序”文件夹，再使用应用内更新。')
    this.working = true; this.emit({ phase: 'installing', error: undefined })
    const stage = join(dirname(target), `.Pi Desk-update-${randomUUID()}.app`)
    const mount = join(this.workspace, 'mount')
    let mounted = false
    try {
      if (await hashFile(this.download) !== this.asset.digest) throw new UpdateError('安装包已发生变化，请重新下载。')
      await fs.mkdir(mount)
      await exec('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, this.download], { timeout: 120_000 })
      mounted = true
      const source = join(mount, 'Pi Desk.app')
      if (!(await fs.lstat(source)).isDirectory()) throw new UpdateError('安装包中没有有效的 Pi Desk。')
      await exec('/usr/bin/ditto', [source, stage], { timeout: 180_000 })
      await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', stage], { timeout: 120_000 })
      const plist = join(stage, 'Contents/Info.plist')
      const read = async (key: string) => (await exec('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])).stdout.trim()
      if (await read('CFBundleIdentifier') !== 'local.pidesk.desktop' || await read('CFBundleShortVersionString') !== this.state.version || await read('CFBundleExecutable') !== 'Pi Desk') throw new UpdateError('安装包的应用身份或版本不匹配。')
      await exec('/usr/bin/lipo', [join(stage, 'Contents/MacOS/Pi Desk'), '-verify_arch', process.arch === 'x64' ? 'x86_64' : 'arm64'])
      const helper = join(this.workspace, 'install.sh')
      await fs.rm(join(this.workspace, 'helper-ready'), { force: true })
      await fs.copyFile(join(process.resourcesPath, 'update-install.sh'), helper)
      await fs.chmod(helper, 0o700)
      return { stage, target, helper, workspace: this.workspace, parentPid: process.pid }
    } catch (error) {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
      this.emit({ phase: 'ready', error: '无法准备安装，请确认应用程序文件夹可写，或重新下载更新。' })
      throw error
    } finally {
      if (mounted) await exec('/usr/bin/hdiutil', ['detach', mount], { timeout: 30_000 }).catch(() => {})
      await fs.rmdir(mount).catch(() => {})
      this.working = false
    }
  }
  async handoff(prepared: Awaited<ReturnType<AppUpdates['stage']>>) {
    const child = spawn('/bin/sh', [prepared.helper, String(prepared.parentPid), prepared.stage, prepared.target, prepared.workspace], { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    child.unref()
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await fs.stat(join(prepared.workspace, 'helper-ready')).then(() => true, () => false)) return
      if (child.exitCode !== null || child.signalCode !== null) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new UpdateError('安装助手未能启动，当前应用不会退出。')
  }
  async cancelInstall(prepared?: Awaited<ReturnType<AppUpdates['stage']>>) {
    if (prepared) await fs.rm(prepared.stage, { recursive: true, force: true }).catch(() => {})
    this.emit({ phase: this.download ? 'ready' : 'error', error: '安装未开始，应用保持当前版本。请稍后重试。' })
  }
}
