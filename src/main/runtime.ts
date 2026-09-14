import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { randomUUID } from 'node:crypto'
import { dirname, delimiter } from 'node:path'
import type { Installation, RuntimeSnapshot, RuntimeAction, JsonObject, ExtensionDialog, DisplayBlock, RevisionDraft } from '../shared/contracts'
import { invocation, searchPaths } from './discovery'
import { activeBranch, clipped, compareModels, displayMessage, modelInfo } from './transcript'

type Pending = { resolve: (data: JsonObject) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
export class PiRuntime {
  get busy() { return this.revising || this.snapshot.dialogs.length > 0 || this.snapshot.queue.steering.length > 0 || this.snapshot.queue.followUp.length > 0 || !['idle', 'closed', 'error'].includes(this.snapshot.phase) }
  preparationTrust?: boolean
  snapshot: RuntimeSnapshot
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<string, Pending>()
  private dialogTimers = new Map<string, NodeJS.Timeout>()
  private stopped = false
  private liveMessageId?: string
  private publishing?: NodeJS.Timeout
  private writeTail: Promise<void> = Promise.resolve()
  private queuedBytes = 0
  private activity: RuntimeSnapshot['phase'] = 'idle'
  private refreshPromise?: Promise<void>
  private statsRefresh?: Promise<void>
  private messageRevision = 0
  private startedMessages = new Map<string, string>()
  private closing?: Promise<void>
  private revising = false
  constructor(cwd: string, private publish: (s: RuntimeSnapshot) => void, private editor: (id: string, text: string) => void, path?: string) {
    this.snapshot = { id: randomUUID(), cwd, sessionPath: path, title: '新会话', completedRuns: 0, phase: 'starting', messages: [], tools: {}, models: [], thinking: '', thinkingLevels: [], commands: [], dialogs: [], statuses: {}, widgets: {}, queue: { steering: [], followUp: [] }, notices: [] }
  }
  emit() {
    if (!this.publishing) this.publishing = setTimeout(() => { this.publishing = undefined; this.publish(this.snapshot) }, 40)
  }
  notice(text: string, level = 'info') { this.snapshot.notices = [...this.snapshot.notices.slice(-19), { id: randomUUID(), text: clipped(text, 4000), level }]; this.emit() }
  private phase(phase: RuntimeSnapshot['phase']) { this.activity = phase; this.snapshot.phase = this.snapshot.dialogs.length ? 'waiting' : phase; this.emit() }
  async start(installation: Installation, agentDir: string, sessionDir: string | undefined, bridge: string, trust?: boolean) {
    this.emit()
    try {
      const cmd = await invocation(installation)
      const args = [...cmd.prefix, '--mode', 'rpc', '--extension', bridge]
      if (this.snapshot.settingsOnly) args.push('--no-session', '--no-tools')
      if (this.snapshot.sessionPath) args.push('--session', this.snapshot.sessionPath)
      if (sessionDir) args.push('--session-dir', sessionDir)
      if (typeof trust === 'boolean') args.push(trust ? '--approve' : '--no-approve')
      const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_DESK: '1', PATH: [...new Set([dirname(installation.node || installation.executable), ...await searchPaths()])].join(delimiter) }
      // Do not carry Electron's Node switch into the user's Pi or its children.
      delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE
      if (this.stopped) return
      this.child = spawn(cmd.file, args, { cwd: this.snapshot.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', shell: false })
      const decoder = new StringDecoder('utf8')
      let buffer = '', bytes = 0, badLines = 0
      this.child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 64 * 1024 * 1024) { this.fail(new Error('Pi 输出单条记录超过 64 MB，连接已停止。原会话仍由 Pi 保存。')); void this.close(false); return }
        buffer += decoder.write(chunk)
        let boundary: number
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, boundary).replace(/\r$/, ''); buffer = buffer.slice(boundary + 1)
          if (!line.trim()) continue
          let event: JsonObject
          try { event = JSON.parse(line) } catch { if (++badLines === 1) this.notice('有扩展向标准输出写入了非协议内容；已忽略这些行。', 'warning'); continue }
          try { if (event && typeof event.type === 'string') this.receive(event) } catch { this.notice('一条 Pi 事件无法显示，任务仍在继续。', 'warning') }
        }
        bytes = Buffer.byteLength(buffer)
      })
      // stderr may contain credential-bearing URLs from extensions; never forward raw logs to the UI.
      this.child.stderr.on('data', () => {})
      this.child.on('error', e => this.fail(new Error(`无法启动 Pi：${e.message}`)))
      this.child.stdin.on('error', () => this.fail(new Error('Pi 输入连接已关闭。')))
      this.child.once('exit', (code, signal) => {
        this.rejectPending(new Error('Pi 进程已退出。未自动重发任何输入。'))
        this.clearDialogs()
        if (!this.stopped) this.fail(new Error(`Pi 已退出（${signal || code}）。可在终端检查扩展加载情况，再重新连接。`))
      })
      // The first response is the readiness handshake. Startup extensions may take time.
      await this.request('get_state', {}, 120_000)
      await this.refresh(true)
      this.phase('idle')
    } catch (e) { this.fail(e); await this.close(false) }
  }
  private rejectPending(error: Error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }; this.pending.clear() }
  private fail(e: unknown) {
    if (this.stopped) return
    this.snapshot.error = e instanceof Error ? e.message : String(e)
    this.phase('error'); this.rejectPending(new Error(this.snapshot.error))
    void this.close(false)
  }
  private async write(value: JsonObject) {
    const line = JSON.stringify(value) + '\n', bytes = Buffer.byteLength(line)
    if (this.queuedBytes + bytes > 40 * 1024 * 1024) throw new Error('等待发送的内容过大，请稍后再试。')
    this.queuedBytes += bytes
    const job = this.writeTail.catch(() => {}).then(() => new Promise<void>((resolve, reject) => {
      if (!this.child || this.child.exitCode !== null || this.child.stdin.destroyed || this.stopped) return reject(new Error('Pi 未连接。'))
      this.child.stdin.write(line, error => error ? reject(error) : resolve())
    })).finally(() => { this.queuedBytes -= bytes })
    this.writeTail = job
    await job
  }
  request(type: string, payload: JsonObject = {}, timeout = 30_000): Promise<JsonObject> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${type} 响应超时；操作可能已被 Pi 接收，请检查状态后再操作。`)) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      void this.write({ ...payload, type, id }).catch(e => { clearTimeout(timer); this.pending.delete(id); reject(e) })
    })
  }
  private receive(event: JsonObject) {
    if (event.type === 'response') {
      const p = this.pending.get(event.id)
      if (p) { clearTimeout(p.timer); this.pending.delete(event.id); event.success ? p.resolve(event.data || {}) : p.reject(new Error(clipped(event.error || 'Pi 拒绝了请求。', 3000))) }
      return
    }
    if (event.type === 'extension_ui_request') { this.extensionUI(event); return }
    if (event.type === 'agent_start') { this.messageRevision++; this.phase('running') }
    if (event.type === 'agent_settled') { this.snapshot.completedRuns++; this.clearDialogs(); this.phase('idle'); this.liveMessageId = undefined; void this.refresh(true).catch(e => this.notice(e.message, 'warning')) }
    if (event.type === 'turn_end') void this.refreshStats().catch(() => {})
    if (event.type === 'thinking_level_changed') this.snapshot.thinking = String(event.level || '')
    if (event.type === 'auto_retry_start' || event.type === 'summarization_retry_scheduled') this.phase('retrying')
    if (event.type === 'compaction_start') this.phase('compacting')
    if (event.type === 'compaction_end') { void this.refreshStats().catch(() => {}); if (event.errorMessage) this.notice(event.errorMessage, 'error'); this.phase(event.willRetry ? 'running' : 'idle') }
    if (event.type === 'extension_error') this.notice(`扩展错误：${event.event || ''} ${event.error || ''}`, 'error')
    if (event.type === 'queue_update') this.snapshot.queue = { steering: (event.steering || []).map(String), followUp: (event.followUp || []).map(String) }
    if (event.type === 'message_start') {
      this.messageRevision++
      const m = displayMessage(event.message, randomUUID())
      this.startedMessages.set(this.messageKey(event.message), m.id)
      if (m.role === 'assistant') { m.streaming = true; this.liveMessageId = m.id }
      this.snapshot.messages = [...this.snapshot.messages.slice(-499), m]
    }
    if (event.type === 'message_update') {
      const delta = event.assistantMessageEvent
      let m = this.snapshot.messages.find(m => m.id === this.liveMessageId)
      if (!m) { m = { id: randomUUID(), role: 'assistant', blocks: [], streaming: true }; this.liveMessageId = m.id; this.snapshot.messages.push(m) }
      const index = Number(delta?.contentIndex)
      if (delta && Number.isInteger(index) && index >= 0 && index < 10000) {
        let block: DisplayBlock = m.blocks[index] || { type: delta.type.startsWith('thinking') ? 'thinking' : delta.type.startsWith('toolcall') ? 'toolCall' : 'text', text: '' }
        if (delta.type === 'text_delta' || delta.type === 'thinking_delta') block.text = clipped((block.text || '') + (delta.delta || ''))
        if (delta.type === 'text_end' && typeof delta.content === 'string') block.text = clipped(delta.content)
        if (delta.type === 'thinking_end' && typeof delta.content === 'string') block.text = clipped(delta.content)
        if (delta.type === 'toolcall_start') block = { type: 'toolCall', id: delta.id, name: delta.toolName, arguments: '' }
        if (delta.type === 'toolcall_delta') block.arguments = clipped((block.arguments || '') + (delta.delta || ''))
        if (delta.type === 'toolcall_end' && delta.toolCall) block = { type: 'toolCall', id: delta.toolCall.id, name: delta.toolCall.name, arguments: clipped(delta.toolCall.arguments) }
        m.blocks[index] = block
      }
    }
    if (event.type === 'message_end') {
      const raw = event.message, role = raw?.role
      let index = role === 'assistant' ? this.snapshot.messages.findIndex(m => m.id === this.liveMessageId) : -1
      const key = this.messageKey(raw), startedId = this.startedMessages.get(key)
      if (index < 0 && startedId) index = this.snapshot.messages.findIndex(m => m.id === startedId)
      this.startedMessages.delete(key)
      const m = displayMessage(raw, index >= 0 ? this.snapshot.messages[index].id : randomUUID())
      m.completedAt = Date.now()
      if (index >= 0) this.snapshot.messages[index] = m; else this.snapshot.messages.push(m)
      if (role === 'assistant') this.liveMessageId = undefined
    }
    if (event.type.startsWith('tool_execution_')) {
      const id = String(event.toolCallId)
      const tool = this.snapshot.tools[id] || { id, name: String(event.toolName), args: clipped(event.args), output: '', status: 'running' as const }
      const result = event.result || event.partialResult
      if (result) tool.output = clipped((result.content || []).filter((b: JsonObject) => b.type === 'text').map((b: JsonObject) => b.text).join('\n'))
      if (event.type === 'tool_execution_end') tool.status = event.isError ? 'error' : 'done'
      this.snapshot.tools[id] = tool
    }
    this.emit()
  }
  private messageKey(message: JsonObject) { return `${message?.role}:${message?.timestamp}:${message?.toolCallId || ''}` }
  private extensionUI(event: JsonObject) {
    if (['select', 'confirm', 'input', 'editor'].includes(event.method)) {
      const dialog: ExtensionDialog = { id: String(event.id), method: event.method, title: String(event.title || 'Pi 需要你的回答'), message: event.message, options: Array.isArray(event.options) ? event.options.map(String) : [], placeholder: event.placeholder, prefill: event.prefill, expiresAt: event.timeout ? Date.now() + Number(event.timeout) : undefined }
      this.snapshot.dialogs.push(dialog)
      if (event.timeout > 0) this.dialogTimers.set(dialog.id, setTimeout(() => this.removeDialog(dialog.id), Number(event.timeout)))
      this.snapshot.phase = 'waiting'
    } else if (event.method === 'notify') this.notice(event.message || '', event.notifyType)
    else if (event.method === 'setStatus') { if (event.statusText) this.snapshot.statuses[event.statusKey] = clipped(event.statusText, 500); else delete this.snapshot.statuses[event.statusKey] }
    else if (event.method === 'setWidget') { if (Array.isArray(event.widgetLines)) this.snapshot.widgets[event.widgetKey] = event.widgetLines.map((s: unknown) => clipped(s, 2000)); else delete this.snapshot.widgets[event.widgetKey] }
    else if (event.method === 'set_editor_text') this.editor(this.snapshot.id, String(event.text || ''))
    this.emit()
  }
  private removeDialog(id: string) {
    clearTimeout(this.dialogTimers.get(id)); this.dialogTimers.delete(id)
    this.snapshot.dialogs = this.snapshot.dialogs.filter(d => d.id !== id)
    this.snapshot.phase = this.snapshot.dialogs.length ? 'waiting' : this.activity; this.emit()
  }
  private clearDialogs() { for (const t of this.dialogTimers.values()) clearTimeout(t); this.dialogTimers.clear(); this.snapshot.dialogs = [] }
  async refresh(history = false) {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.doRefresh(history).finally(() => { this.refreshPromise = undefined })
    return this.refreshPromise
  }
  private async refreshSettings() {
    // An earlier refresh may have read state before a setting changed.
    if (this.refreshPromise) await this.refreshPromise
    await this.refresh()
  }
  private setStats(data: JsonObject) {
    const nonnegative = (n: unknown): number | undefined => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
    this.snapshot.stats = {
      tokens: nonnegative(data.tokens?.total) ?? 0, cost: nonnegative(data.cost),
      contextPercent: nonnegative(data.contextUsage?.percent),
      contextTokens: nonnegative(data.contextUsage?.tokens),
      contextWindow: nonnegative(data.contextUsage?.contextWindow)
    }
  }
  private async refreshStats() {
    if (this.stopped) return
    if (this.statsRefresh) return this.statsRefresh
    this.statsRefresh = this.request('get_session_stats').then(data => { this.setStats(data); this.emit() }).finally(() => { this.statsRefresh = undefined })
    return this.statsRefresh
  }
  private async doRefresh(history: boolean) {
    const revision = this.messageRevision
    const state = await this.request('get_state')
    this.snapshot.sessionPath = state.sessionFile; this.snapshot.title = state.sessionName || this.snapshot.title
    this.snapshot.model = modelInfo(state.model); this.snapshot.thinking = String(state.thinkingLevel || '')
    const outcomes = await Promise.allSettled([this.request('get_available_models'), this.request('get_available_thinking_levels'), this.request('get_commands'), this.request('get_session_stats')])
    const data = outcomes.map(r => r.status === 'fulfilled' ? r.value : undefined)
    this.snapshot.settingsErrors = {
      models: outcomes[0].status === 'rejected' ? '模型列表读取失败，请重试加载。' : undefined,
      thinking: outcomes[1].status === 'rejected' ? '思考档位读取失败，请重试加载。' : undefined
    }
    if (data[0]) this.snapshot.models = (data[0].models || []).map(modelInfo).filter(Boolean).sort(compareModels)
    if (data[1]) {
      // Use Pi's supported levels, respecting explicit exclusions from discovery.
      // In upstream-default mode Pi can return a placeholder "off" for a model with no controls.
      this.snapshot.thinkingLevels = (data[1].levels || []).map(String).filter((level: string) =>
        this.snapshot.model?.thinkingLevelMap?.[level] !== null)
    }
    if (data[2]) this.snapshot.commands = (data[2].commands || []).map((c: JsonObject) => ({ name: String(c.name), description: String(c.description || ''), source: String(c.source || '') }))
    if (data[3]) this.setStats(data[3])
    if (history && !state.isStreaming && !this.liveMessageId && revision === this.messageRevision) {
      try {
        const result = await this.request('get_entries')
        if (revision === this.messageRevision) {
          this.snapshot.messages = activeBranch(result.entries || [], result.leafId).filter(e => e.type === 'message').slice(-500).map(e => ({ ...displayMessage(e.message, e.id), entryId: e.id, completedAt: Date.parse(e.timestamp) || undefined }))
          this.startedMessages.clear()
          const visibleIds = new Set(this.snapshot.messages.flatMap(m => m.blocks.filter(b => b.type === 'toolCall').map(b => b.id)))
          for (const id of Object.keys(this.snapshot.tools)) if (!visibleIds.has(id)) delete this.snapshot.tools[id]
        }
      } catch { const result = await this.request('get_messages'); if (revision === this.messageRevision) this.snapshot.messages = (result.messages || []).slice(-500).map((m: JsonObject, i: number) => displayMessage(m, `history-${i}`)) }
    }
    if (!state.sessionName) {
      const firstUser = this.snapshot.messages.find(m => m.role === 'user')
      const title = firstUser?.blocks.find(b => b.type === 'text')?.text
      if (title) this.snapshot.title = title.replace(/\s+/g, ' ').slice(0, 70)
    }
    this.emit()
  }
  async act(action: RuntimeAction) {
    if (this.revising && action.type !== 'dialog') throw new Error('正在修改对话，请稍候。')
    if (action.type === 'activate' && !this.snapshot.settingsOnly) { this.snapshot.prepared = false; this.emit(); return }
    if (this.snapshot.settingsOnly) {
      const settingsCommand = action.type === 'prompt' && /^\/gateway-(?:thinking(?: (?:default|off|minimal|low|medium|high|xhigh|max|budget \d+))?|model-info)$/.test(action.message)
      if (!['model', 'thinking', 'refresh', 'dialog', 'close'].includes(action.type) && !settingsCommand) throw new Error('请先选择项目，再发送消息。')
      if (settingsCommand && !this.snapshot.commands.some(c => c.name === (action as { message: string }).message.slice(1).split(' ')[0])) throw new Error('本机 Pi 没有加载这个设置命令。')
    }
    if (action.type === 'dialog') {
      const dialog = this.snapshot.dialogs.find(d => d.id === action.id)
      if (!dialog) throw new Error('此问题已过期或已回答。')
      if (!action.cancelled && dialog.method === 'select' && !dialog.options?.includes(action.value || '')) throw new Error('请选择有效选项。')
      await this.write({ type: 'extension_ui_response', id: action.id, value: action.value, confirmed: action.confirmed, cancelled: action.cancelled })
      this.removeDialog(action.id); return
    }
    if (action.type === 'close') { await this.close(); return }
    if (action.type === 'stop') {
      await this.request('clear_queue')
      for (const d of [...this.snapshot.dialogs]) { await this.write({ type: 'extension_ui_response', id: d.id, cancelled: true }); this.removeDialog(d.id) }
      await this.request('abort', {}, 120_000); this.phase('idle'); await this.refresh(true); return
    }
    if (this.snapshot.phase === 'starting' || this.snapshot.phase === 'error' || this.snapshot.phase === 'closed') throw new Error('Pi 尚未就绪。')
    if (action.type === 'prompt') {
      if (action.images?.length && !this.snapshot.model?.input.includes('image')) throw new Error('当前模型未声明支持图片，请先选择支持图片的模型。')
      await this.request('prompt', { message: action.message, images: action.images, streamingBehavior: action.behavior }, 300_000)
      // Slash commands can alter models without starting an agent run.
      if (action.message.startsWith('/') && this.activity === 'idle') await this.refreshSettings()
      return
    }
    if (action.type === 'refresh') { await this.refreshSettings(); return }
    if (this.activity !== 'idle') throw new Error('请等待本轮结束后再修改会话设置。')
    if (action.type === 'model') await this.request('set_model', { provider: action.provider, modelId: action.modelId })
    if (action.type === 'thinking') {
      await this.refreshSettings()
      if (!this.snapshot.thinkingLevels.includes(action.level)) throw new Error('当前模型不支持这个思考档位，请重新选择。')
      if (this.snapshot.statuses['gateway-thinking'] && this.snapshot.commands.some(c => c.name === 'gateway-thinking')) {
        // Choosing an effort must leave upstream-default mode, even when Pi already holds that level.
        await this.request('prompt', { message: `/gateway-thinking ${action.level}` })
      } else await this.request('set_thinking_level', { level: action.level })
    }
    if (action.type === 'rename') { await this.request('set_session_name', { name: action.name }); this.snapshot.title = action.name }
    if (action.type === 'compact') await this.request('compact', {}, 300_000)
    if (action.type === 'compact') await this.refresh(true)
    else await this.refreshSettings()
  }
  private async revisionEntry(entryId: string) {
    if (this.snapshot.settingsOnly || this.snapshot.prepared || this.snapshot.phase !== 'idle') throw new Error('请先等待当前任务结束。')
    const state = await this.request('get_state')
    if (state.isStreaming || state.pendingMessageCount > 0 || this.snapshot.queue.steering.length || this.snapshot.queue.followUp.length) throw new Error('请先完成或清空排队消息。')
    const entries = await this.request('get_entries')
    const users = activeBranch(entries.entries || [], entries.leafId).filter(e => e.type === 'message' && e.message.role === 'user')
    const entry = users.find(e => e.id === entryId)
    if (!entry) throw new Error('这条消息已不在当前分支，请重新打开会话。')
    return { entry, latest: users.at(-1)?.id === entryId }
  }
  async revisionDraft(entryId: string): Promise<RevisionDraft> {
    const { entry } = await this.revisionEntry(entryId)
    const content = entry.message.content
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }]
    const text = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n')
    const images = blocks.filter(b => b.type === 'image').map(b => ({ type: 'image' as const, data: b.data, mimeType: b.mimeType }))
    if (text.length > 1_000_000 || images.length > 4 || images.some(b => typeof b.data !== 'string' || b.data.length > 12_000_000 || !/^image\/(png|jpeg|webp|gif)$/.test(b.mimeType)) || images.reduce((n, b) => n + b.data.length, 0) > 24_000_000) throw new Error('原消息或附件超过编辑容量，请在 Pi 中处理，避免丢失内容。')
    return { text, images }
  }
  async revise(entryId: string, mode: 'edit' | 'fork', input?: Extract<RuntimeAction, { type: 'prompt' }>) {
    if (this.revising) throw new Error('正在修改对话，请稍候。')
    this.revising = true
    let applied = false
    try {
      if (this.refreshPromise) await this.refreshPromise
      const { entry, latest } = await this.revisionEntry(entryId)
      if (mode === 'edit') {
        if (!latest || !input) throw new Error('只能编辑最近一条用户消息；更早的消息请另开分支。')
        if (input.images?.length && !this.snapshot.model?.input.includes('image')) throw new Error('当前模型不支持这些图片。请先更换模型。')
        if (!this.snapshot.commands.some(c => c.name === 'desk-edit-message')) throw new Error('当前连接未加载消息编辑功能，请重新连接 Pi。')
        await this.request('prompt', { message: `/desk-edit-message ${entryId}` }, 300_000)
        const result = await this.request('get_entries')
        if (result.leafId !== entry.parentId) throw new Error('回退未完成或被扩展取消，原消息没有重发。')
      } else {
        const result = await this.request('fork', { entryId }, 300_000)
        if (result.cancelled) throw new Error('扩展取消了创建分支。')
      }
      applied = true
      this.messageRevision++; this.liveMessageId = undefined; this.snapshot.completedRuns = 0
      await this.refresh(true)
      if (mode === 'edit') await this.request('prompt', { message: input!.message, images: input!.images }, 300_000)
      return { snapshot: this.snapshot, applied }
    } catch (e) {
      if (!applied) throw e
      await this.refresh(true).catch(() => {})
      return { snapshot: this.snapshot, applied, error: `对话已回退，但后续操作未完成：${e instanceof Error ? e.message : String(e)}。输入已保留，请检查后再发送。` }
    } finally { this.revising = false; this.emit() }
  }
  close(showClosed = true): Promise<void> {
    if (this.closing) return this.closing
    this.closing = this.doClose(showClosed)
    return this.closing
  }
  private async doClose(showClosed: boolean) {
    this.stopped = true; this.rejectPending(new Error('连接已关闭。')); this.clearDialogs()
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null && child.pid) {
      const pid = child.pid
      const signal = (sig: NodeJS.Signals) => { try { process.platform === 'win32' ? child.kill(sig) : process.kill(-pid, sig) } catch {} }
      signal('SIGTERM')
      await new Promise<void>(resolve => { const timer = setTimeout(() => { signal('SIGKILL'); resolve() }, 2500); child.once('exit', () => { clearTimeout(timer); resolve() }) })
    }
    if (showClosed) { this.snapshot.phase = 'closed'; this.emit() }
  }
}
