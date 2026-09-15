import { createReadStream, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { CachedModelSettings, RuntimeSnapshot, DefaultModel, ModelCatalog, ModelInfo, Preferences, SessionInfo, ProjectTrust } from '../shared/contracts'
import { displayMessage, activeBranch, compareModels, modelInfo } from './transcript'

export const expand = (p: string) => p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(p)
export async function jsonFile(path: string, fallback: any = {}): Promise<any> {
  try { const stat = await fs.stat(path); if (stat.size > 4 * 1024 * 1024) return fallback; return JSON.parse((await fs.readFile(path, 'utf8')).replace(/^\uFEFF/, '')) } catch { return fallback }
}
export class Storage {
  preferences!: Preferences
  knownSessions = new Map<string, SessionInfo>()
  approvedPaths = new Set<string>()
  titles: Record<string, { title: string; source: 'auto' | 'manual' }> = {}
  private titleWriting: Promise<void> = Promise.resolve()
  private writing: Promise<void> = Promise.resolve()
  private catalogWriting: Promise<void> = Promise.resolve()
  private modelDataWriting: Promise<void> = Promise.resolve()
  private lastCatalog = ''
  constructor(private directory: string) {}
  async init() {
    await fs.mkdir(this.directory, { recursive: true })
    const saved = await jsonFile(join(this.directory, 'preferences.json'))
    this.titles = await jsonFile(join(this.directory, 'session-titles.json'))
    this.preferences = {
      desktopNotifications: saved.desktopNotifications !== false,
      naming: { enabled: saved.naming?.enabled === true, provider: typeof saved.naming?.provider === 'string' ? saved.naming.provider : '', modelId: typeof saved.naming?.modelId === 'string' ? saved.naming.modelId : '' },
      executable: typeof saved.executable === 'string' ? saved.executable : '',
      node: typeof saved.node === 'string' ? saved.node : '',
      agentDir: typeof saved.agentDir === 'string' ? saved.agentDir : process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'),
      sessionDir: typeof saved.sessionDir === 'string' ? saved.sessionDir : '',
      projects: Array.isArray(saved.projects) ? saved.projects.filter((x: unknown) => typeof x === 'string') : [],
      archived: Array.isArray(saved.archived) ? saved.archived : [],
      pinned: Array.isArray(saved.pinned) ? saved.pinned : [],
      theme: ['light', 'dark', 'system'].includes(saved.theme) ? saved.theme : 'light'
    }
  }
  async save(patch: Partial<Preferences>) {
    this.preferences = { ...this.preferences, ...patch }
    const content = JSON.stringify(this.preferences, null, 2)
    this.writing = this.writing.catch(() => {}).then(async () => {
      const path = join(this.directory, 'preferences.json')
      await fs.writeFile(`${path}.tmp`, content, { mode: 0o600 }); await fs.rename(`${path}.tmp`, path)
    })
    await this.writing
    return this.preferences
  }
  async catalogScope() {
    const root = await this.root()
    const stamps = await Promise.all(['models.json', 'auth.json', 'gateway-models.json'].map(name => fs.stat(join(root, name)).then(s => s.mtimeMs).catch(() => 0)))
    const settings = await jsonFile(join(root, 'settings.json'))
    // Pi persists the selected model/effort here. Those changes do not invalidate model capabilities.
    // Hash the remaining settings instead of storing private configuration in the catalog key.
    const relevant = Object.fromEntries(Object.keys(settings).sort().filter(key => !['defaultProvider', 'defaultModel', 'defaultThinkingLevel'].includes(key)).map(key => [key, settings[key]]))
    const settingsDigest = createHash('sha256').update(JSON.stringify(relevant)).digest('hex')
    return JSON.stringify([root, this.preferences.executable, this.preferences.node, settingsDigest, ...stamps])
  }
  async cacheModels(models: ModelInfo[], scope: string) {
    const safe = models.map(modelInfo).filter((m): m is ModelInfo => !!m).sort(compareModels)
    if (!safe.length) return
    const fingerprint = JSON.stringify({ scope, models: safe })
    if (fingerprint === this.lastCatalog) return
    this.lastCatalog = fingerprint
    this.catalogWriting = this.catalogWriting.catch(() => {}).then(async () => {
      const path = join(this.directory, 'model-catalog.json')
      await fs.writeFile(`${path}.tmp`, JSON.stringify({ scope, models: safe, updatedAt: Date.now() }), { mode: 0o600 })
      await fs.rename(`${path}.tmp`, path)
    })
    await this.catalogWriting
  }
  private async modelDataContext(cwd?: string, trusted = false) {
    const root = await this.root()
    const filename = createHash('sha256').update(JSON.stringify([root, cwd || '', trusted])).digest('hex')
    const projectStamp = cwd && trusted ? await fs.stat(join(cwd, '.pi/settings.json')).then(s => s.mtimeMs).catch(() => 0) : 0
    const scope = JSON.stringify([await this.catalogScope(), cwd || '', trusted, projectStamp])
    const settings = await jsonFile(join(root, 'settings.json'))
    const gateway = await jsonFile(join(root, 'gateway-thinking.json'))
    const preference = createHash('sha256').update(JSON.stringify([settings.defaultThinkingLevel, gateway])).digest('hex')
    return { file: join(this.directory, 'model-data', `${filename}.json`), scope, preference }
  }
  async cacheModelData(snapshot: RuntimeSnapshot, cwd?: string, trusted = false) {
    if (!snapshot.model || snapshot.settingsErrors?.thinking || !snapshot.thinking) return
    const model = modelInfo(snapshot.model)!
    const status = snapshot.statuses['gateway-thinking'] || ''
    const state: CachedModelSettings = {
      provider: model.provider, id: model.id, thinking: snapshot.thinking,
      levels: snapshot.thinkingLevels.filter(v => ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(v)),
      mode: status.includes('上游默认') ? 'default' : status.includes('推理预算') ? 'budget' : 'level',
      defaultAvailable: snapshot.commands.some(c => c.name === 'gateway-thinking'), updatedAt: Date.now()
    }
    const models = snapshot.models.map(modelInfo).filter((m): m is ModelInfo => !!m)
    const position = models.findIndex(m => m.provider === model.provider && m.id === model.id)
    if (position >= 0) models[position] = model; else models.push(model)
    const context = await this.modelDataContext(cwd, trusted)
    this.modelDataWriting = this.modelDataWriting.catch(() => {}).then(async () => {
      // Ignore results from a connection whose configuration changed while the write was queued.
      const current = await this.modelDataContext(cwd, trusted)
      if (current.scope !== context.scope || current.preference !== context.preference) return
      const previous = await jsonFile(context.file)
      const states = previous.scope === context.scope && Array.isArray(previous.states) ? previous.states : []
      const kept = states.filter((s: any) => s.state?.provider !== state.provider || s.state?.id !== state.id).slice(-499)
      const data = JSON.stringify({ scope: context.scope, models: models.slice(0, 5000), updatedAt: Date.now(), states: [...kept, { preference: context.preference, state }] })
      if (Buffer.byteLength(data) > 4 * 1024 * 1024) return
      await fs.mkdir(dirname(context.file), { recursive: true })
      await fs.writeFile(`${context.file}.tmp`, data, { mode: 0o600 }); await fs.rename(`${context.file}.tmp`, context.file)
    })
    await this.modelDataWriting
  }
  async modelCatalog(cwd?: string, trusted = false): Promise<ModelCatalog> {
    const context = await this.modelDataContext(cwd, trusted)
    const data = await jsonFile(context.file)
    if (data.scope === context.scope && Array.isArray(data.models)) {
      const models = data.models.map(modelInfo).filter((m: ModelInfo | undefined): m is ModelInfo => !!m).sort(compareModels)
      const settings: CachedModelSettings[] = (Array.isArray(data.states) ? data.states : []).filter((s: any) => s.preference === context.preference).flatMap((s: any) => {
        const v = s.state
        if (!v || typeof v.provider !== 'string' || typeof v.id !== 'string' || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(v.thinking) || !['level', 'default', 'budget'].includes(v.mode) || !Array.isArray(v.levels)) return []
        return [{ provider: v.provider, id: v.id, thinking: v.thinking, mode: v.mode, levels: v.levels.filter((l: unknown) => ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(l))), defaultAvailable: v.defaultAvailable === true, updatedAt: Number(v.updatedAt) || 0 }]
      })
      if (models.length) return { models, settings, source: 'cache', updatedAt: Number(data.updatedAt) || undefined }
    }
    return this.legacyModelCatalog()
  }
  private async legacyModelCatalog(): Promise<ModelCatalog> {
    const cached = await jsonFile(join(this.directory, 'model-catalog.json'))
    if (cached.scope === await this.catalogScope() && Array.isArray(cached.models)) {
      const models = cached.models.map(modelInfo).filter((m: ModelInfo | undefined): m is ModelInfo => !!m).sort(compareModels)
      if (models.length) return { models, source: 'cache', updatedAt: cached.updatedAt }
    }
    // Cold start: read only bounded head/tail fragments of already indexed history.
    // These are past choices, not a claim of present availability or capability.
    const models = new Map<string, ModelInfo>()
    const paths = [...this.knownSessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 64).map(s => s.path)
    for (let i = 0; i < paths.length; i += 8) await Promise.all(paths.slice(i, i + 8).map(async path => {
      const file = await fs.open(path, 'r').catch(() => undefined)
      if (!file) return
      try {
        const stat = await file.stat()
        for (const offset of new Set([0, Math.max(0, stat.size - 16_384)])) {
          const buffer = Buffer.alloc(16_384)
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
          for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
            try {
              const entry = JSON.parse(line.replace(/^\uFEFF/, ''))
              const provider = entry.type === 'model_change' ? entry.provider : entry.message?.role === 'assistant' ? entry.message.provider : undefined
              const id = entry.type === 'model_change' ? entry.modelId : entry.message?.role === 'assistant' ? entry.message.model : undefined
              if (typeof provider !== 'string' || typeof id !== 'string' || !provider || !id || provider.length > 300 || id.length > 1000 || /[\x00-\x1f]/.test(provider + id)) continue
              models.set(`${provider}/${id}`, { provider, id, name: id, reasoning: false, input: [], contextWindow: 0 })
            } catch {}
          }
        }
      } catch {} finally { await file.close() }
    }))
    return { models: [...models.values()].sort(compareModels), source: 'recent' }
  }
  async defaultModel(): Promise<DefaultModel | undefined> {
    const settings = await jsonFile(join(await this.root(), 'settings.json'))
    const provider = settings.defaultProvider, id = settings.defaultModel
    if (typeof provider !== 'string' || typeof id !== 'string' || !provider || !id || provider.length > 300 || id.length > 1000 || /[\x00-\x1f]/.test(provider + id)) return undefined
    // A display hint only. Pi still resolves availability and trusted project overrides.
    const cached = await jsonFile(join(this.directory, 'model-catalog.json'))
    const model = cached.scope === await this.catalogScope() && Array.isArray(cached.models)
      ? cached.models.map(modelInfo).find((m: ModelInfo | undefined) => m?.provider === provider && m.id === id) : undefined
    const thinking = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(settings.defaultThinkingLevel) ? settings.defaultThinkingLevel as string : undefined
    return { provider, id, name: model?.name || id, thinking }
  }
  async setTitle(path: string, title: string, source: 'auto' | 'manual') {
    if (source === 'auto' && this.titles[path]) return
    this.titles[path] = { title, source }
    const content = JSON.stringify(this.titles, null, 2)
    this.titleWriting = this.titleWriting.catch(() => {}).then(async () => {
      const file = join(this.directory, 'session-titles.json')
      await fs.writeFile(`${file}.tmp`, content, { mode: 0o600 }); await fs.rename(`${file}.tmp`, file)
    })
    await this.titleWriting
  }
  async root() { return expand(this.preferences.agentDir) }
  async sessionRoot() {
    const root = await this.root()
    const settings = await jsonFile(join(root, 'settings.json'))
    const configured = this.preferences.sessionDir || process.env.PI_CODING_AGENT_SESSION_DIR || settings.sessionDir
    return typeof configured === 'string' && configured ? (configured.startsWith('~') || isAbsolute(configured) ? expand(configured) : resolve(root, configured)) : join(root, 'sessions')
  }
  async index(): Promise<{ sessions: SessionInfo[]; warnings: string[] }> {
    const warnings: string[] = [], paths: string[] = []
    const root = await this.sessionRoot()
    try {
      const items = await fs.readdir(root, { withFileTypes: true })
      for (const item of items) {
        if (item.isFile() && item.name.endsWith('.jsonl')) paths.push(join(root, item.name))
        else if (item.isDirectory()) {
          const children = await fs.readdir(join(root, item.name), { withFileTypes: true }).catch(() => [])
          for (const child of children) if (child.isFile() && child.name.endsWith('.jsonl')) paths.push(join(root, item.name, child.name))
        }
      }
    } catch (e: any) { if (e.code !== 'ENOENT') warnings.push('部分 Pi 历史记录暂时无法读取。') }
    for (const path of this.approvedPaths) if (path.endsWith('.jsonl')) paths.push(path)
    const sessions: SessionInfo[] = []
    for (let i = 0; i < paths.length; i += 8) {
      const batch = await Promise.all(paths.slice(i, i + 8).map(path => this.metadata(path).catch(() => null)))
      for (const item of batch) if (item) sessions.push(item)
    }
    this.knownSessions = new Map(sessions.map(s => [s.path, s]))
    return { sessions: [...this.knownSessions.values()].sort((a, b) => b.updatedAt - a.updatedAt), warnings }
  }
  async metadata(path: string): Promise<SessionInfo | null> {
    const handle = await fs.open(path, 'r')
    try {
      const stat = await handle.stat(), limit = 256 * 1024
      const first = Buffer.alloc(Math.min(stat.size, limit)), tail = Buffer.alloc(Math.min(stat.size, limit))
      await handle.read(first, 0, first.length, 0)
      await handle.read(tail, 0, tail.length, Math.max(0, stat.size - tail.length))
      const records = (s: string) => s.split('\n').flatMap(line => { try { return [JSON.parse(line.replace(/^\uFEFF/, ''))] } catch { return [] } })
      const beginning = records(first.toString('utf8')), ending = records(tail.toString('utf8'))
      const header = beginning.find(e => e.type === 'session')
      if (!header || typeof header.cwd !== 'string' || !isAbsolute(header.cwd)) return null
      // A session name may sit in the middle of a long append-only transcript.
      let named: string | undefined
      const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
      try { for await (const line of lines) { if (!line.includes('session_info')) continue; try { const entry = JSON.parse(line); if (entry.type === 'session_info' && typeof entry.name === 'string') named = entry.name } catch {} } } finally { lines.close() }
      const firstUser = beginning.find(e => e.type === 'message' && e.message?.role === 'user')?.message
      const text = typeof firstUser?.content === 'string' ? firstUser.content : firstUser?.content?.find((b: any) => b.type === 'text')?.text
      return { path, id: String(header.id || path), cwd: header.cwd, version: Number(header.version || 1), named: Boolean(named || this.titles[path]), title: String(this.titles[path]?.title || named || text || '未命名会话').replace(/\s+/g, ' ').slice(0, 160), updatedAt: stat.mtimeMs }
    } finally { await handle.close() }
  }
  async history(path: string, recentOnly = true) {
    if (!this.knownSessions.has(path)) throw new Error('请从会话列表或文件选择器打开记录。')
    const stat = await fs.stat(path)
    if (stat.size > 64 * 1024 * 1024) throw new Error('该会话超过 64 MB，首版暂不展开。可在 Pi 终端中继续。')
    const entries: any[] = []
    for (const line of (await fs.readFile(path, 'utf8')).split('\n')) { try { entries.push(JSON.parse(line.replace(/^\uFEFF/, ''))) } catch {} }
    const branch = activeBranch(entries)
    return { messages: branch.filter(e => e.type === 'message').slice(recentOnly ? -500 : 0).map((e, i) => ({ ...displayMessage(e.message, String(e.id || i)), entryId: typeof e.id === 'string' ? e.id : undefined, completedAt: Date.parse(e.timestamp) || undefined })), notice: branch.length > 500 ? '显示当前分支最近 500 条记录；原始会话保持完整。' : undefined }
  }
  async historyPage(path: string, before?: string) {
    const all = (await this.history(path, false)).messages
    const end = before === undefined ? all.length : all.findIndex(m => m.entryId === before)
    if (end < 0) throw new Error('会话分支已变化，请重新打开会话。')
    const start = Math.max(0, end - 100)
    return { messages: all.slice(start, end), hasMore: start > 0 }
  }
  async authorizeProject(cwd: string) {
    const path = await fs.realpath(cwd)
    const allowed = [...this.preferences.projects, ...this.approvedPaths, ...[...this.knownSessions.values()].map(s => s.cwd)]
    let matches = false
    for (const p of new Set(allowed)) if (path === await fs.realpath(p).catch(() => '')) { matches = true; break }
    if (!matches || !(await fs.stat(path)).isDirectory()) throw new Error('请先选择项目文件夹。')
    return path
  }
  async trust(cwd: string): Promise<ProjectTrust> {
    cwd = await this.authorizeProject(cwd)
    const root = await this.root(), trust = await jsonFile(join(root, 'trust.json'))
    for (let dir = cwd; ; dir = dirname(dir)) {
      if (typeof trust[dir] === 'boolean') return { needsDecision: false, source: trust[dir] ? 'Pi 已信任此项目' : '沿用 Pi：不加载项目配置' }
      if (dirname(dir) === dir) break
    }
    const settings = await jsonFile(join(root, 'settings.json'))
    if (settings.defaultProjectTrust === 'always' || settings.defaultProjectTrust === 'never') return { needsDecision: false, source: '沿用 Pi 全局信任设置' }
    let resources = await fs.access(join(cwd, '.pi')).then(() => true).catch(() => false)
    for (let dir = cwd; ; dir = dirname(dir)) {
      resources ||= await fs.access(join(dir, '.agents/skills')).then(() => true).catch(() => false)
      if (dirname(dir) === dir || await fs.access(join(dir, '.git')).then(() => true).catch(() => false)) break
    }
    return { needsDecision: resources, source: resources ? '此项目包含尚未信任的 Pi 配置或 Skill' : '使用本机 Pi 配置' }
  }
}
