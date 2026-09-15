import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { DisplayMessage, RecoveryPreview, RuntimeSnapshot } from '../shared/contracts'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const anchor = (m: DisplayMessage) => hash(JSON.stringify([m.timestamp, m.blocks]))
type Record = RecoveryPreview & { path: string; anchor: string }
// A display-only checkpoint. Never append to Pi JSONL or replay recovered text.
export class RecoveryStore {
  private anchors = new Map<string, { id: string; value: string; timestamp: number }>()
  private states = new Map<string, { value?: Record; timer?: NodeJS.Timeout; tail: Promise<void> }>()
  constructor(private directory: string) {}
  private file(path: string) { return join(this.directory, `${hash(path)}.json`) }
  observe(snapshot: RuntimeSnapshot) {
    const path = snapshot.sessionPath
    if (!path || snapshot.settingsOnly || snapshot.prepared) return
    const message = snapshot.messages.findLast(m => m.role === 'assistant')
    const user = snapshot.messages.findLast(m => m.role === 'user')
    if (!message?.timestamp) return
    const previousAnchor = this.anchors.get(path)
    if ((!user?.timestamp && !previousAnchor) || message.timestamp < (user?.timestamp || previousAnchor!.timestamp)) return
    let state = this.states.get(path)
    if (message.entryId) {
      if (state?.value && state.value.message.timestamp === message.timestamp) {
        state.value = undefined; clearTimeout(state.timer); state.timer = undefined
        state.tail = state.tail.catch(() => {}).then(() => fs.rm(this.file(path), { force: true })).catch(() => {})
      }
      return
    }
    let remaining = 250_000, truncated = false
    const source = message.blocks.filter(b => b.type === 'text' || b.type === 'thinking')
    truncated = source.length > 32
    const blocks = source.slice(0, 32).map(b => { const text = (b.text || '').slice(0, Math.min(100_000, remaining)); remaining -= text.length; truncated ||= text.length < (b.text || '').length; return { type: b.type, text } })
    if (!blocks.some(b => b.text.trim())) return
    if (!state) { state = { tail: Promise.resolve() }; this.states.set(path, state) }
    let key = this.anchors.get(path)
    if (user && (!key || key.id !== user.id)) { key = { id: user.id, value: anchor(user), timestamp: user.timestamp! }; this.anchors.set(path, key) }
    state.value = { path, anchor: key!.value, savedAt: Date.now(), truncated, message: { id: `recovered-${message.timestamp}`, role: 'assistant', timestamp: message.timestamp, blocks } }
    if (!state.timer) { state.timer = setTimeout(() => { state!.timer = undefined; void this.flush(path).catch(() => {}) }, 1500); state.timer.unref() }
  }
  private async flush(path: string) {
    const state = this.states.get(path)
    if (!state) return
    clearTimeout(state.timer); state.timer = undefined
    const content = state.value && JSON.stringify(state.value)
    if (content && Buffer.byteLength(content) <= 4 * 1024 * 1024) state.tail = state.tail.catch(() => {}).then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
      const target = this.file(path)
      await fs.writeFile(`${target}.tmp`, content, { mode: 0o600 }); await fs.rename(`${target}.tmp`, target)
    })
    await state.tail
  }
  async flushAll() { await Promise.allSettled([...this.states.keys()].map(path => this.flush(path))) }
  async read(path: string, messages: DisplayMessage[]): Promise<RecoveryPreview | undefined> {
    try {
      const file = this.file(path), stat = await fs.stat(file)
      if (stat.size > 4 * 1024 * 1024) return
      const value = JSON.parse(await fs.readFile(file, 'utf8')) as Record
      if (value.path !== path || !value.message?.timestamp || !Array.isArray(value.message.blocks)) return
      // Native persisted history wins, including failed/aborted native replies.
      if (messages.some(m => m.role === 'assistant' && m.timestamp === value.message.timestamp)) { await this.dismiss(path); return }
      const user = messages.findLast(m => m.role === 'user')
      if (!user || anchor(user) !== value.anchor) return
      if (value.message.blocks.some(b => !['text', 'thinking'].includes(b.type) || typeof b.text !== 'string')) return
      return { message: value.message, savedAt: value.savedAt, truncated: value.truncated === true }
    } catch { return }
  }
  async dismiss(path: string) {
    const state = this.states.get(path)
    if (state) { clearTimeout(state.timer); state.timer = undefined; state.value = undefined; await state.tail.catch(() => {}) }
    await fs.rm(this.file(path), { force: true })
  }
}
