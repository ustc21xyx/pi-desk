import { Notification, type BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { jsonFile } from './storage'
import type { RuntimeSnapshot } from '../shared/contracts'
// @pi-lab/notify's default OSC output has no terminal in Desk. A configured
// external script can show its own native notification, so give it ownership.
export async function hasPiNotificationScript(agentDir: string, cwd: string, projectTrusted: boolean) {
  const settings = [await jsonFile(join(agentDir, 'settings.json'))]
  if (projectTrusted) settings.push(await jsonFile(join(cwd, '.pi/settings.json')))
  const installed = settings.some(s => Array.isArray(s?.packages) && s.packages.some((p: any) => String(typeof p === 'string' ? p : p?.source || '').includes('@pi-lab/notify')))
  if (!installed) return false
  const global = await jsonFile(join(homedir(), '.pi/agent/pi-lab/notify.json'))
  const local = await jsonFile(join(cwd, '.pi/pi-lab/notify.json'))
  const config = { ...global?.notify, ...local?.notify }
  return config.enable !== false && typeof config.script === 'string' && !!config.script.trim()
}
export class DesktopNotifications {
  viewing: string | null = null
  private previous = new Map<string, { runs: number; question?: string; failed: boolean }>()
  private toasts = new Map<string, Notification>()
  constructor(private window: () => BrowserWindow | null, private navigate: (id: string) => void) {}
  visible(id: string) { const win = this.window(); return this.viewing === id && !!win?.isVisible() && win.isFocused() }
  observe(s: RuntimeSnapshot, enabled: boolean, external: boolean) {
    if (s.settingsOnly || s.prepared) return
    const old = this.previous.get(s.id), question = s.dialogs[0]?.id, failed = s.phase === 'error'
    this.previous.set(s.id, { runs: s.completedRuns, question, failed })
    const kind = failed && !old?.failed ? 'error' : question && old?.question !== question ? 'question' : old && s.completedRuns > old.runs ? s.outcome || 'complete' : undefined
    if (this.visible(s.id)) s.unread = undefined
    else if (kind) s.unread = kind
    if (!kind || !enabled || external || this.visible(s.id) || !Notification.isSupported()) return
    const win = this.window()
    if (kind === 'complete' && win?.isVisible() && win.isFocused()) return
    this.toasts.get(s.id)?.close()
    const toast = new Notification({ title: 'Pi Desk', body: kind === 'question' ? '有一个会话需要你的回答' : kind === 'error' ? '有一个会话未完成，请查看原因' : '任务已完成，点击查看回复', silent: true })
    this.toasts.set(s.id, toast)
    toast.on('click', () => this.navigate(s.id))
    toast.on('close', () => { if (this.toasts.get(s.id) === toast) this.toasts.delete(s.id) })
    toast.on('failed', () => this.toasts.delete(s.id))
    toast.show()
  }
}
