import { spawn } from 'node:child_process'
import { delimiter, dirname } from 'node:path'
import { discover, searchPaths } from './discovery'
import type { Storage } from './storage'
import type { NamingStatus } from '../shared/contracts'

export class NamingService {
  status: NamingStatus = { running: false, total: 0, completed: 0, failed: 0, skipped: 0 }
  private controller?: AbortController
  private lifetime = new AbortController()
  private pending = new Map<string, Promise<void>>()
  constructor(private store: Storage, private helper: string, private publish: (status: NamingStatus) => void, private changed: (path: string, title: string) => void) {}
  private emit() { this.publish({ ...this.status }) }
  async request(action: 'models' | 'title', excerpt?: string, signal?: AbortSignal) {
    const prefs = this.store.preferences, naming = { ...prefs.naming }
    if (!naming.provider || (action === 'title' && !naming.modelId)) throw new Error('请先设置命名服务商和模型。')
    const installations = await discover(prefs)
    const installation = installations.find(i => prefs.executable ? i.executable === prefs.executable : i.compatible)
    if (!installation?.node) throw new Error('未找到本机 Pi 的 Node.js。')
    const agentDir = await this.store.root(), paths = await searchPaths()
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    signal.throwIfAborted()
    return new Promise<any>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: [dirname(installation.node), ...paths].join(delimiter) }; delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(installation.node, [this.helper], { env, stdio: ['pipe', 'pipe', 'pipe'] })
      let output = '', finished = false
      const finish = (error?: Error, value?: any) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value) }
      const abort = () => { child.kill('SIGKILL'); finish(new Error('命名请求已取消或超时。')) }
      const timer = setTimeout(abort, 100_000)
      signal?.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', data => { output += data.toString(); if (output.length > 4_000_000) abort() })
      child.stderr.on('data', () => {})
      child.on('error', () => finish(new Error('无法启动命名服务。')))
      child.stdin.on('error', () => finish(new Error('命名服务连接已关闭。')))
      child.on('exit', () => { try { const value = JSON.parse(output); value.error ? finish(new Error(value.error)) : finish(undefined, value) } catch { finish(new Error('命名服务未返回有效结果。')) } })
      child.stdin.end(JSON.stringify({ action, agentDir, executable: installation.executable, ...naming, excerpt }))
    })
  }
  async models() { return (await this.request('models')).models as { provider: string; id: string }[] }
  async name(path: string, signal?: AbortSignal) {
    if (this.pending.has(path)) return this.pending.get(path)
    const work = this.doName(path, signal).finally(() => this.pending.delete(path))
    this.pending.set(path, work); return work
  }
  private async doName(path: string, signal?: AbortSignal) {
    const meta = await this.store.metadata(path)
    if (!meta || meta.named) return
    const { messages } = await this.store.history(path, false)
    const excerpt = messages.filter(m => m.role === 'user').map(m => m.blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n'))
      .map(t => t.replace(/<(environment_context|system-reminder|INSTRUCTIONS|instructions|context|app-context|recommended_plugins)[\s\S]*?<\/\1>/gi, '').replace(/(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9_.-]+|(?:api[_-]?key|token|password)\s*[:=]\s*\S+)/gi, '[已隐藏]'))
      .filter(t => t.trim()).slice(0, 5).map(t => t.slice(0, 1000)).join('\n\n').slice(0, 4000)
    if (!excerpt.trim()) return
    const result = await this.request('title', excerpt, signal)
    if (!result.title) return
    // A manual rename during generation always wins.
    if ((await this.store.metadata(path))?.named) return
    await this.store.setTitle(path, result.title, 'auto'); this.changed(path, result.title)
  }
  async batch() {
    if (this.status.running) return
    this.status = { running: true, total: 0, completed: 0, failed: 0, skipped: 0 }; this.controller = new AbortController(); this.emit()
    try {
      const { sessions } = await this.store.index(), queue = sessions.filter(s => !s.named)
      this.status.total = queue.length; this.status.skipped = sessions.length - queue.length; this.emit()
      let failuresInARow = 0
      const worker = async () => {
        while (queue.length && !this.controller!.signal.aborted) {
          const session = queue.shift()!
          try { await this.name(session.path, this.controller!.signal); if (this.store.titles[session.path]) this.status.completed++; else this.status.skipped++; failuresInARow = 0 }
          catch (e) {
            if (this.controller!.signal.aborted) break
            this.status.failed++; failuresInARow++; this.status.error = e instanceof Error ? e.message : '命名失败。'
            if (failuresInARow >= 3) this.controller!.abort()
          }
          this.emit()
        }
      }
      // Two requests at most; every title is persisted before taking another item.
      await Promise.all([worker(), worker()])
    } catch (e) { this.status.error = e instanceof Error ? e.message : '命名失败。' }
    finally { this.status.running = false; this.controller = undefined; this.emit() }
  }
  close() { this.cancel(); this.lifetime.abort() }
  cancel() { this.controller?.abort() }
}
