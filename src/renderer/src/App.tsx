import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive, ArrowUp, Check, ChevronDown, ChevronRight, Circle, Code2, Folder, FolderOpen, GitBranch, ImagePlus, LoaderCircle, MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRight, Pin, Plus, Search, Settings2, Sparkles, Square, SquarePen, Terminal, X, Zap } from 'lucide-react'
import type { Bootstrap, DisplayMessage, ModelCatalog, ModelInfo, Preferences, RuntimeAction, RuntimeSnapshot, SessionInfo, RevisionDraft } from '../../shared/contracts'
import { clean, ContextMeter, errorText, FilePanel, Mark, Modal, nameOf, phaseLabels, Question, Transcript } from './components'

type Selection = { kind: 'new' } | { kind: 'runtime'; id: string } | { kind: 'history'; path: string }
type Attachment = { type: 'image'; name: string; data: string; mimeType: string }
type Decision = { title: string; body: string; options: { label: string; value: boolean }[]; resolve: (answer: boolean | null) => void }
const running = (phase: string) => !['idle', 'closed', 'error', 'starting'].includes(phase)
const suggestions = [
  { icon: Code2, title: '读懂项目', detail: '结构、入口与运行方式', prompt: '请先调查这个项目，解释目录结构、主要入口和运行方式，暂时不要修改代码。' },
  { icon: GitBranch, title: '检查改动', detail: '关注问题与潜在影响', prompt: '请检查当前项目未提交的修改，指出具体问题和影响，先不要修改文件。' },
  { icon: Sparkles, title: '开始构建', detail: '把一个想法变成作品', prompt: '我想在这个项目中实现一个新功能：' }
]
const thinkingLabels: Record<string, string> = { off: '关闭思考', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' }
// Friendly names can change after discovery; search both identities without separator sensitivity.
const modelSearchText = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
function matchesModel(model: ModelInfo, query: string) {
  const values = [model.id, model.name, model.provider, `${model.provider}/${model.id}`].map(modelSearchText)
  return query.trim().split(/\s+/).filter(Boolean).every(part => values.some(value => value.includes(modelSearchText(part))))
}
const relativeTime = (time: number) => { const d = Date.now() - time; return d < 60_000 ? '刚刚' : d < 3600_000 ? `${Math.floor(d / 60_000)}分` : d < 86400_000 ? `${Math.floor(d / 3600_000)}时` : `${Math.floor(d / 86400_000)}天` }

export default function App() {
  const [boot, setBoot] = useState<Bootstrap>(), [runtimes, setRuntimes] = useState<Record<string, RuntimeSnapshot>>({})
  const [active, setActive] = useState<Selection>({ kind: 'new' }), [project, setProject] = useState('')
  const [settingsId, setSettingsId] = useState('')
  const [preparation, setPreparation] = useState<{ cwd: string; id?: string; trust?: boolean; needsTrust?: boolean; error?: string }>({ cwd: '' })
  const preparationGeneration = useRef(0)
  const [catalog, setCatalog] = useState<ModelCatalog>({ models: [], source: 'recent' }), [catalogReading, setCatalogReading] = useState(false)
  const [draftModel, setDraftModel] = useState<ModelInfo>()
  const pendingSettings = useRef<{ model?: { provider: string; modelId: string }; thinking?: string }>({})
  const [history, setHistory] = useState<DisplayMessage[]>([]), [historyNotice, setHistoryNotice] = useState(''), [historyLoading, setHistoryLoading] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>(() => { try { const value = JSON.parse(localStorage.getItem('pi-desk-drafts') || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {} } catch { return {} } })
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({})
  const [query, setQuery] = useState(''), [archivedView, setArchivedView] = useState(false), [sidebar, setSidebar] = useState(true), [panel, setPanel] = useState(false)
  const [projectLimits, setProjectLimits] = useState<Record<string, number>>({})
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({})
  const [modal, setModal] = useState<'settings' | 'models' | 'catalog' | 'thinking' | 'commands' | 'rename' | null>(null), [modelQuery, setModelQuery] = useState(''), [rename, setRename] = useState('')
  const [loadingSettings, setLoadingSettings] = useState<'models' | 'thinking' | null>(null), [savingSettings, setSavingSettings] = useState(false)
  const [decision, setDecision] = useState<Decision>(), [error, setError] = useState(''), [sending, setSending] = useState(false), [menu, setMenu] = useState(false)
  const [revision, setRevision] = useState<{ runtimeId: string; entryId: string; mode: 'edit' | 'fork'; draft: RevisionDraft; sourcePath?: string; applied?: boolean; error?: string }>()
  const [revisionLoading, setRevisionLoading] = useState(false), [revisionSending, setRevisionSending] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null), searchRef = useRef<HTMLInputElement>(null), latest = useRef(runtimes), starting = useRef(false), generation = useRef(0)
  const warmCandidate = preparation.cwd === project && preparation.id ? runtimes[preparation.id] : undefined
  const warmRuntime = warmCandidate?.prepared ? warmCandidate : undefined
  const runtime = active.kind === 'runtime' ? runtimes[active.id] : active.kind === 'new' ? warmRuntime || runtimes[settingsId] : undefined
  const selectedHistory = active.kind === 'history' ? boot?.sessions.find(s => s.path === active.path) : undefined
  const cwd = (runtime?.settingsOnly ? '' : runtime?.cwd) || selectedHistory?.cwd || project
  const draftKey = active.kind === 'runtime' ? active.id : active.kind === 'history' ? active.path : `new:${project}`
  const draft = drafts[draftKey] || '', images = attachments[draftKey] || []
  const messages = active.kind === 'history' ? history : runtime?.messages || []
  const isHistory = active.kind === 'history', busy = !!runtime && !runtime.settingsOnly && !runtime.prepared && running(runtime.phase)
  const hasConnection = active.kind === 'runtime' && runtime && !runtime.settingsOnly && !runtime.prepared && !['closed', 'error'].includes(runtime.phase)
  const commands = runtime?.commands || []
  const fastAvailable = commands.some(c => c.name === 'fast')
  const gatewayAvailable = commands.some(c => c.name === 'gateway-thinking')
  const draftModelMismatch = active.kind === 'new' && draftModel && (draftModel.id !== runtime?.model?.id || draftModel.provider !== runtime?.model?.provider)
  const gatewayStatus = draftModelMismatch ? '' : clean(runtime?.statuses['gateway-thinking'] || '')
  const upstreamDefault = gatewayStatus.includes('上游默认')
  const budgetMode = gatewayStatus.includes('推理预算')
  const thinkingChoices = runtime?.thinkingLevels.filter(level => !(level === 'off' && (upstreamDefault || budgetMode) && !runtime.model?.reasoning)) || []
  const thinkingLabel = draftModelMismatch ? '思考强度' : upstreamDefault ? '上游默认' : budgetMode ? '预算' : runtime?.model && !runtime.model.reasoning ? '无可调档位' : thinkingLabels[runtime?.thinking || ''] || '思考强度'
  const controlsLocked = busy || sending || savingSettings || !!loadingSettings
  const preferences = boot?.preferences
  const projects = [...new Set([...(preferences?.projects || []), ...(boot?.sessions || []).map(s => s.cwd)])]
  const updateDraft = (text: string, key = draftKey) => setDrafts(d => ({ ...d, [key]: text }))
  const notify = (e: unknown) => setError(errorText(e))
  const reload = useCallback(async () => {
    const data = await window.desk.bootstrap(); setBoot(data)
    setRuntimes(previous => Object.fromEntries([...data.runtimes.map(r => [r.id, r] as const), ...Object.entries(previous)]))
  }, [])
  useEffect(() => {
    if (!window.desk) { setError('请通过 Pi Desk 桌面应用打开此界面。'); return }
    const off = window.desk.onRuntime(snapshot => { latest.current = { ...latest.current, [snapshot.id]: snapshot }; setRuntimes(r => ({ ...r, [snapshot.id]: snapshot })) })
    const offNaming = window.desk.onNaming(status => { setBoot(b => b ? { ...b, namingStatus: status } : b); if (!status.running) void reload().catch(notify) })
    const offEditor = window.desk.onEditor(event => setDrafts(d => ({ ...d, [event.id]: event.text })))
    void reload().catch(notify)
    return () => { off(); offEditor(); offNaming() }
  }, [reload])
  useEffect(() => { latest.current = runtimes }, [runtimes])
  useEffect(() => { const timer = setTimeout(() => { try { localStorage.setItem('pi-desk-drafts', JSON.stringify(drafts)) } catch {} }, 350); return () => clearTimeout(timer) }, [drafts])
  useEffect(() => { pendingSettings.current = {}; setDraftModel(undefined); setCatalog({ models: [], source: 'recent' }); setSettingsId('') }, [boot?.preferences.agentDir, boot?.preferences.executable, boot?.preferences.node])
  useEffect(() => { document.documentElement.dataset.theme = preferences?.theme || 'light' }, [preferences?.theme])
  useEffect(() => {
    const el = textRef.current
    if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 220)}px` }
  }, [draft, active])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (document.querySelector('dialog[open]')) return
      if (e.key === 'n') { e.preventDefault(); setActive({ kind: 'new' }); setMenu(false) }
      if (e.key === 'k') { e.preventDefault(); searchRef.current?.focus(); setSidebar(true) }
      if (e.key === 'b') { e.preventDefault(); setSidebar(s => !s) }
      if (e.key === ',') { e.preventDefault(); setModal('settings') }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    const id = ++generation.current
    if (active.kind !== 'history') { setHistoryLoading(false); return }
    setHistory([]); setHistoryLoading(true); setHistoryNotice('')
    void window.desk.history(active.path).then(result => { if (generation.current === id) { setHistory(result.messages); setHistoryNotice(result.notice || '') } }).catch(e => { if (generation.current === id) notify(e) }).finally(() => { if (generation.current === id) setHistoryLoading(false) })
    return () => { generation.current++ }
  }, [active])
  useEffect(() => {
    const revision = ++preparationGeneration.current
    if (active.kind !== 'new' || !project || !boot) return
    const timer = setTimeout(() => {
      setPreparation({ cwd: project })
      void window.desk.projectTrust(project).then(async info => {
        if (revision !== preparationGeneration.current) return
        if (info.needsDecision) { setPreparation({ cwd: project, needsTrust: true }); return }
        const id = await window.desk.start({ cwd: project, prepared: true })
        if (revision === preparationGeneration.current) setPreparation({ cwd: project, id })
      }).catch(e => { if (revision === preparationGeneration.current) setPreparation({ cwd: project, error: errorText(e) }) })
    }, 300)
    return () => { clearTimeout(timer); if (revision === preparationGeneration.current) preparationGeneration.current++ }
  }, [active.kind, project, !!boot, boot?.preferences.agentDir, boot?.preferences.executable, boot?.preferences.node, boot?.preferences.sessionDir])
  async function prepareWithTrust(trust: boolean) {
    const target = project, revision = ++preparationGeneration.current
    setPreparation({ cwd: target, trust })
    try {
      const id = await window.desk.start({ cwd: target, trust, prepared: true })
      if (revision === preparationGeneration.current) setPreparation({ cwd: target, trust, id })
    } catch (e) { if (revision === preparationGeneration.current) setPreparation({ cwd: target, trust, error: errorText(e) }) }
  }
  // Refresh the disk index after a task settles, never on every streamed token.
  const settled = Object.values(runtimes).filter(r => !r.settingsOnly && !r.prepared && r.phase === 'idle').map(r => `${r.id}:${r.sessionPath}:${r.title}`).join('|')
  useEffect(() => { if (!settled) return; const timer = setTimeout(() => void reload().catch(notify), 800); return () => clearTimeout(timer) }, [settled, reload])
  async function save(patch: Partial<Preferences>) { const preferences = await window.desk.savePreferences(patch); setBoot(b => b ? { ...b, preferences } : b) }
  async function chooseProject() {
    try { const path = await window.desk.selectPath('project'); if (path) { setProject(path); setActive({ kind: 'new' }); await reload() }; return path } catch (e) { notify(e); return null }
  }
  function ask(title: string, body: string, options: Decision['options']) { return new Promise<boolean | null>(resolve => setDecision({ title, body, options, resolve })) }
  function decide(answer: boolean | null) { decision?.resolve(answer); setDecision(undefined) }
  async function waitUntilReady(id: string) {
    const current = latest.current[id]
    if (current?.phase === 'idle') return
    if (current && ['error', 'closed'].includes(current.phase)) throw new Error(current.error || 'Pi 连接已关闭。')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('连接尚未完成，输入已保留。请稍后检查状态再发送。')) }, 155_000)
      const off = window.desk.onRuntime(snapshot => {
        if (snapshot.id !== id) return
        if (snapshot.phase === 'idle') { clearTimeout(timer); off(); resolve() }
        if (['error', 'closed'].includes(snapshot.phase)) { clearTimeout(timer); off(); reject(new Error(snapshot.error || 'Pi 连接已关闭。')) }
      })
    })
  }
  async function connect(): Promise<string | null> {
    if (hasConnection) { await waitUntilReady(runtime.id); return runtime.id }
    if (starting.current) return null
    starting.current = true
    try {
      const targetProject = cwd || await chooseProject()
      if (!targetProject) return null
      const path = selectedHistory?.path || (runtime?.settingsOnly || runtime?.prepared ? undefined : runtime?.sessionPath)
      const info = await window.desk.projectTrust(targetProject)
      let trust = !path && preparation.cwd === targetProject ? preparation.trust : undefined
      if (info.needsDecision && typeof trust !== 'boolean') {
        const result = await ask('加载项目配置？', `${nameOf(targetProject)} 包含项目级 Pi 配置或扩展。加载后，Pi 会按该项目的设置工作。此选择仅用于本次连接。`, [{ label: '仅用全局配置', value: false }, { label: '加载项目配置', value: true }])
        if (result === null) return null
        trust = result
      }
      const id = await window.desk.start({ cwd: targetProject, sessionPath: path, trust, prepared: !path })
      if (!path) await window.desk.action(id, { type: 'activate' })
      setDrafts(d => ({ ...d, [id]: d[draftKey] || '' })); setAttachments(a => ({ ...a, [id]: a[draftKey] || [] }))
      setActive({ kind: 'runtime', id }); setMenu(false)
      await waitUntilReady(id)
      if (!path && active.kind === 'new') {
        const selected = pendingSettings.current
        if (selected.model) await window.desk.action(id, { type: 'model', ...selected.model })
        if (selected.thinking) await window.desk.action(id, { type: 'thinking', level: selected.thinking })
      }
      return id
    } finally { starting.current = false }
  }
  async function openAgentSettings(kind: 'models' | 'thinking') {
    if (controlsLocked) return
    if (kind === 'models' && active.kind === 'new') {
      setModal('catalog'); setError(''); setModelQuery(''); setCatalogReading(true)
      void window.desk.modelCatalog().then(setCatalog).catch(notify).finally(() => setCatalogReading(false))
      // Opening the picker never waits for the Pi startup handshake.
      if (!project) void window.desk.prepareSettings().then(setSettingsId).catch(notify)
      return
    }
    setLoadingSettings(kind); setError(''); setModelQuery('')
    try {
      if (active.kind === 'new' && !project) {
        const id = await window.desk.prepareSettings()
        setSettingsId(id)
        await waitUntilReady(id)
        if (pendingSettings.current.model) await window.desk.action(id, { type: 'model', ...pendingSettings.current.model })
        if (pendingSettings.current.thinking) await window.desk.action(id, { type: 'thinking', level: pendingSettings.current.thinking })
        await window.desk.action(id, { type: 'refresh' })
        setModal(kind)
      } else {
        const id = await connect()
        if (id) { await window.desk.action(id, { type: 'refresh' }); setActive({ kind: 'runtime', id }); setModal(kind) }
      }
    } catch (e) { notify(e) } finally { setLoadingSettings(null) }
  }
  async function applyAgentSetting(action: RuntimeAction, close = true) {
    if (!runtime || savingSettings) return
    setSavingSettings(true); setError('')
    try {
      await window.desk.action(runtime.id, action)
      if (runtime.settingsOnly || runtime.prepared) {
        if (action.type === 'model') { pendingSettings.current = { model: { provider: action.provider, modelId: action.modelId } }; setDraftModel(runtime.models.find(m => m.provider === action.provider && m.id === action.modelId)) }
        if (action.type === 'thinking' && runtime.model) pendingSettings.current = { model: { provider: runtime.model.provider, modelId: runtime.model.id }, thinking: action.level }
        if (action.type === 'prompt' && action.message === '/gateway-thinking default' && runtime.model) pendingSettings.current = { model: { provider: runtime.model.provider, modelId: runtime.model.id } }
      }
      if (close) setModal(null)
    } catch (e) { notify(e) } finally { setSavingSettings(false) }
  }
  async function perform(action: RuntimeAction) { if (!runtime) return; try { await window.desk.action(runtime.id, action) } catch (e) { notify(e) } }
  async function beginRevision(message: DisplayMessage, mode: 'edit' | 'fork') {
    if (!message.entryId || controlsLocked || revisionLoading) return
    setRevisionLoading(true); setError('')
    try {
      const id = await connect(); if (!id) return
      const draft = await window.desk.revisionDraft(id, message.entryId)
      setRevision({ runtimeId: id, entryId: message.entryId, mode, draft, sourcePath: latest.current[id]?.sessionPath })
    } catch (e) { notify(e) } finally { setRevisionLoading(false) }
  }
  async function submitRevision() {
    if (!revision || revisionSending) return
    const value = revision
    setRevisionSending(true)
    try {
      if (value.applied) {
        await window.desk.action(value.runtimeId, { type: 'prompt', message: value.draft.text, images: value.draft.images })
      } else {
        const result = await window.desk.revise(value.runtimeId, value.entryId, value.mode, value.mode === 'edit' ? { message: value.draft.text, images: value.draft.images } : undefined)
        latest.current = { ...latest.current, [result.snapshot.id]: result.snapshot }
        setRuntimes(r => ({ ...r, [result.snapshot.id]: result.snapshot }))
        if (result.error) { setRevision({ ...value, applied: result.applied, error: result.error }); return }
        if (value.mode === 'fork') {
          setDrafts(d => ({ ...d, ...(value.sourcePath ? { [value.sourcePath]: d[value.runtimeId] || '' } : {}), [value.runtimeId]: value.draft.text }))
          setAttachments(a => ({ ...a, ...(value.sourcePath ? { [value.sourcePath]: a[value.runtimeId] || [] } : {}), [value.runtimeId]: value.draft.images.map((image, i) => ({ ...image, name: `原消息图片 ${i + 1}` })) }))
        }
      }
      setActive({ kind: 'runtime', id: value.runtimeId }); setRevision(undefined)
      void reload().catch(notify)
    } catch (e) { setRevision({ ...value, error: errorText(e) }) } finally { setRevisionSending(false) }
  }
  async function send() {
    if (sending || savingSettings || loadingSettings || (!draft.trim() && !images.length)) return
    const message = draft, selectedImages = images, originalKey = draftKey
    setSending(true); setError('')
    try {
      let id: string | null
      if (active.kind === 'runtime' && runtime && !runtime.settingsOnly && !runtime.prepared && !['error', 'closed', 'starting'].includes(runtime.phase)) id = runtime.id
      else id = await connect()
      if (!id) return
      const latestRuntime = latest.current[id]
      await window.desk.action(id, { type: 'prompt', message, images: selectedImages.map(({ name: _name, ...image }) => image), behavior: latestRuntime && running(latestRuntime.phase) ? 'steer' : undefined })
      setDrafts(d => { const copy = { ...d }; if (copy[originalKey] === message) copy[originalKey] = ''; if (copy[id!] === message) copy[id!] = ''; return copy })
      setAttachments(a => ({ ...a, [originalKey]: (a[originalKey] || []).filter(image => !selectedImages.includes(image)), [id!]: (a[id!] || []).filter(image => !selectedImages.includes(image)) }))
    } catch (e) { notify(e) } finally { setSending(false) }
  }
  async function addImages() { try { const picked = await window.desk.pickImages(); if (picked.length + images.length > 4) throw new Error('每条消息最多添加 4 张图片。'); setAttachments(a => ({ ...a, [draftKey]: [...images, ...picked] })) } catch (e) { notify(e) } }
  function openSession(session: SessionInfo) {
    const current = Object.values(runtimes).find(r => r.sessionPath === session.path && !['closed', 'error'].includes(r.phase))
    setActive(current ? { kind: 'runtime', id: current.id } : { kind: 'history', path: session.path }); setProject(session.cwd); setMenu(false); setError('')
  }
  async function toggleMeta(key: 'pinned' | 'archived', path: string) { const current = preferences?.[key] || []; try { await save({ [key]: current.includes(path) ? current.filter(p => p !== path) : [...current, path] }) } catch (e) { notify(e) } }
  const preparedPaths = new Set(Object.values(runtimes).filter(r => r.prepared).map(r => r.sessionPath))
  const visibleSessions = (boot?.sessions || []).filter(s => !preparedPaths.has(s.path) && Boolean(preferences?.archived.includes(s.path)) === archivedView && `${s.title} ${s.cwd}`.toLowerCase().includes(query.toLowerCase()))
  const pinnedSessions = visibleSessions.filter(s => preferences?.pinned.includes(s.path))
  const pinnedKey = `pinned:${query}`, pinnedLimit = projectLimits[pinnedKey] || 5
  const activePath = (runtime?.settingsOnly || runtime?.prepared ? undefined : runtime?.sessionPath) || selectedHistory?.path
  const pendingRuntimes = Object.values(runtimes).filter(r => !r.settingsOnly && !r.prepared && !['closed'].includes(r.phase) && (!r.sessionPath || !(boot?.sessions || []).some(s => s.path === r.sessionPath)))
  const viewTitle = (activePath && boot?.sessions.find(s => s.path === activePath)?.title) || runtime?.title || selectedHistory?.title || '新会话'
  const catalogLive = (runtime?.settingsOnly || runtime?.prepared) && runtime.phase === 'idle' && !runtime.settingsErrors?.models && runtime.models.length > 0
  const catalogModels = catalogLive ? runtime.models : catalog.models
  const matchedCatalog = catalogModels.filter(m => matchesModel(m, modelQuery))
  const runtimeStatus = runtime?.prepared ? runtime.phase === 'idle' ? '项目已就绪' : ['error', 'closed'].includes(runtime.phase) ? '准备未完成' : '正在准备项目' : runtime?.settingsOnly ? '全局模型配置' : runtime ? phaseLabels[runtime.phase] : isHistory ? '历史预览' : '本地工作区'

  const sessionRow = (session: SessionInfo) => {
    const rt = Object.values(runtimes).find(r => r.sessionPath === session.path && r.phase !== 'closed')
    return <div key={session.path} className={`session-row ${activePath === session.path ? 'selected' : ''}`}>
      <button className="session-main" onClick={() => openSession(session)} title={session.title}>{rt && running(rt.phase) ? <span className={`status-dot ${rt.phase}`} /> : preferences?.pinned.includes(session.path) ? <Pin size={12} /> : <MessageSquare size={13} />}<span>{session.title}</span><time>{relativeTime(session.updatedAt)}</time></button>
      <button className="session-action" title={archivedView ? '取消归档' : '归档'} aria-label={archivedView ? '取消归档' : '归档'} onClick={() => void toggleMeta('archived', session.path)}><Archive size={12} /></button>
    </div>
  }
  return <div className={`app-shell ${sidebar ? '' : 'sidebar-hidden'} ${panel && cwd ? 'with-panel' : ''}`}>
    {sidebar && <aside className="sidebar"><div className="window-drag sidebar-drag" /><div className="sidebar-brand"><Mark /><span>Pi Desk</span><button className="icon-button" title="收起侧栏 ⌘B" onClick={() => setSidebar(false)} aria-label="收起侧栏"><PanelLeftClose size={17} /></button></div>
      <button className="new-chat" onClick={() => { setActive({ kind: 'new' }); setArchivedView(false); setError(''); setMenu(false); textRef.current?.focus() }}><Plus size={18} /><span>新会话</span><kbd>⌘ N</kbd></button>
      <label className="search-field"><Search size={15} /><input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索会话" aria-label="搜索会话" /><kbd>⌘ K</kbd></label>
      <div className="sidebar-scroll">
        <div className="section-label"><span>{archivedView ? '已归档' : '工作区'}</span><button className="icon-button" title="添加项目" aria-label="添加项目" onClick={() => void chooseProject()}><Plus size={14} /></button></div>
        {pendingRuntimes.map(r => <button key={r.id} className={`runtime-row ${active.kind === 'runtime' && active.id === r.id ? 'selected' : ''}`} onClick={() => { setActive({ kind: 'runtime', id: r.id }); setProject(r.cwd) }}><span className={`status-dot ${r.phase}`} /><span>{r.title}<small>{nameOf(r.cwd)}</small></span><small>{phaseLabels[r.phase]}</small></button>)}
        {!archivedView && visibleSessions.some(s => preferences?.pinned.includes(s.path)) && <div className="pinned-group"><div className="mini-label">置顶</div>{pinnedSessions.slice(0, pinnedLimit).map(sessionRow)}<div className="session-disclosure">{pinnedSessions.length > pinnedLimit && <button className="more-sessions" onClick={() => setProjectLimits(old => ({ ...old, [pinnedKey]: pinnedLimit + 5 }))}>显示更多</button>}{pinnedLimit > 5 && <button className="more-sessions" onClick={() => setProjectLimits(old => ({ ...old, [pinnedKey]: 5 }))}>收起</button>}</div></div>}
        {projects.filter(p => visibleSessions.some(s => s.cwd === p) || (preferences?.projects.includes(p) && !query && !archivedView)).map(p => {
          const sessions = visibleSessions.filter(s => s.cwd === p && (archivedView || !preferences?.pinned.includes(s.path)))
          const limit = projectLimits[`${archivedView}:${query}:${p}`] || 5
          const setLimit = (value: number) => setProjectLimits(old => ({ ...old, [`${archivedView}:${query}:${p}`]: value }))
          const collapsed = !!collapsedProjects[p]
          const listId = `project-sessions-${encodeURIComponent(p)}`
          return <div className="project-group" key={p}>
            <div className="project-heading">
              <button className={`project-row ${cwd === p ? 'current' : ''}`} onClick={() => setCollapsedProjects(old => ({ ...old, [p]: !old[p] }))} title={p} aria-expanded={!collapsed} aria-controls={listId}>
                <Folder size={15} /><span>{nameOf(p)}</span>{collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              </button>
              <button className="icon-button project-new-chat" title="新建会话" aria-label={`在 ${nameOf(p)} 中新建会话`} onClick={() => {
                setProject(p); setActive({ kind: 'new' }); setArchivedView(false); setError(''); setMenu(false)
                setCollapsedProjects(old => ({ ...old, [p]: false }))
                textRef.current?.focus()
              }}><SquarePen size={15} /></button>
            </div>
            <div id={listId} hidden={collapsed}>
              {sessions.slice(0, limit).map(sessionRow)}
              <div className="session-disclosure">
                {sessions.length > limit && <button className="more-sessions" onClick={() => setLimit(limit + 5)}>显示更多</button>}
                {limit > 5 && <button className="more-sessions" onClick={() => setLimit(5)}>收起</button>}
              </div>
            </div>
          </div>
        })}
        {!boot && <div className="sidebar-empty">正在读取本机工作区…</div>}
        {boot && !projects.length && <div className="sidebar-empty">打开一个项目，<br />开始你的第一个会话。</div>}
        {boot && !visibleSessions.length && (query || archivedView) && <div className="sidebar-empty">没有找到会话</div>}
      </div>
      <footer className="sidebar-footer"><button className={archivedView ? 'active' : ''} onClick={() => setArchivedView(v => !v)}><Archive size={16} />{archivedView ? '返回工作区' : '已归档'}</button><button onClick={() => setModal('settings')}><Settings2 size={16} />设置<span className="local-chip">本机</span></button><div className="sidebar-note"><span className="local-dot" />你的 Pi，你的工作区</div></footer>
    </aside>}
    <main className="workspace"><header className="topbar window-drag">{!sidebar && <button className="icon-button" onClick={() => setSidebar(true)} title="展开侧栏" aria-label="展开侧栏"><PanelLeftOpen size={18} /></button>}<div className="breadcrumb"><span>{cwd ? nameOf(cwd) : '工作区'}</span><ChevronRight size={13} /><strong>{viewTitle}</strong></div><div className="topbar-actions"><span className={`connection-state ${runtime?.phase || ''}`}><span className="status-dot" />{runtimeStatus}</span><button className={`icon-button ${panel ? 'active' : ''}`} disabled={!cwd} title="文件与修改差异" aria-label="文件与修改差异" onClick={() => setPanel(v => !v)}><PanelRight size={18} /></button><div className="menu-anchor"><button className="icon-button" disabled={(!runtime || runtime.settingsOnly || runtime.prepared) && !isHistory} onClick={() => setMenu(v => !v)} title="会话操作" aria-label="会话操作"><MoreHorizontal size={19} /></button>{menu && <div className="popover session-menu">{activePath && <button onClick={() => { setRename(viewTitle); setModal('rename'); setMenu(false) }}>重命名会话</button>}{runtime && <><button onClick={() => { void perform({ type: 'refresh' }); setMenu(false) }}>刷新模型与状态</button><button disabled={busy} onClick={() => { void perform({ type: 'compact' }); setMenu(false) }}>压缩上下文</button><button onClick={() => { void perform({ type: 'close' }); setMenu(false) }}>结束此连接</button></>}{activePath && <><button onClick={() => { void toggleMeta('pinned', activePath); setMenu(false) }}>{preferences?.pinned.includes(activePath) ? '取消置顶' : '置顶会话'}</button><button onClick={() => { void toggleMeta('archived', activePath); setMenu(false) }}>{preferences?.archived.includes(activePath) ? '取消归档' : '归档会话'}</button></>}</div>}</div></div></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="关闭错误"><X size={15} /></button></div>}
      {runtime?.error && runtime.error !== error && <div className="error-banner"><span>{runtime.error}</span></div>}
      {isHistory && <div className="history-banner"><div className="history-summary"><span><Circle size={12} />历史预览{historyNotice ? ` · ${historyNotice}` : ' · 当前分支'}</span><small>继续或发送消息将续写原会话，请勿同时在终端中使用。</small></div><button onClick={() => void connect().catch(notify)}>继续这个会话<ChevronRight size={14} /></button></div>}
      {historyLoading ? <div className="center-state"><LoaderCircle className="spin" size={23} /><span>正在打开会话…</span></div> : messages.length ? <Transcript key={active.kind === 'runtime' ? active.id : active.kind === 'history' ? active.path : 'new'} messages={messages} runtime={runtime} onRevise={(message, mode) => void beginRevision(message, mode)} revisionDisabled={controlsLocked || revisionLoading || revisionSending || runtime?.phase === "starting"} /> : <div className="welcome"><div className="welcome-content"><div className="welcome-overline"><Mark /><span>PI DESK</span></div><h1>从一个想法开始。</h1><p>与本机 Pi 一起，读懂代码，解决问题，创造新东西。</p><div className="welcome-project">{cwd ? <><FolderOpen size={16} /><span title={cwd}>{nameOf(cwd)}</span><span className="small-dot" />本地项目</> : <button onClick={() => void chooseProject()}><FolderOpen size={16} />选择项目文件夹<ChevronRight size={15} /></button>}</div><div className="suggestion-grid">{suggestions.map(s => <button key={s.title} onClick={() => { updateDraft(s.prompt); textRef.current?.focus() }}><s.icon size={18} /><strong>{s.title}</strong><span>{s.detail}</span></button>)}</div>{runtime?.phase === 'starting' && !runtime.settingsOnly && !runtime.prepared && <div className="starting-note"><LoaderCircle className="spin" size={15} />正在加载本机 Pi 与扩展…</div>}</div></div>}
      <div className="composer-region">
        {active.kind === 'new' && project && <div className="project-readiness" role="status">
          {preparation.cwd === project && preparation.needsTrust ? <><span>提前准备项目：是否加载这个项目的 Pi 配置与扩展？</span><button disabled={sending} onClick={() => void prepareWithTrust(false)}>仅用全局配置</button><button disabled={sending} onClick={() => void prepareWithTrust(true)}>加载项目配置</button></> : (preparation.cwd === project && preparation.error) || warmRuntime?.error || warmRuntime?.phase === 'closed' ? <span>项目准备未完成，输入已保留。发送时可重新连接。</span> : warmRuntime?.phase === 'idle' ? <><Check size={13} /><span>项目已就绪</span></> : <><LoaderCircle size={13} className="spin" /><span>正在后台准备项目，你可以继续输入…</span></>}
        </div>}

        {runtime?.dialogs[0] && <Question key={runtime.dialogs[0].id} question={runtime.dialogs[0]} onError={setError} answer={value => window.desk.action(runtime.id, { type: 'dialog', id: runtime.dialogs[0].id, ...value })} />}
        {runtime && runtime.queue.steering.length + runtime.queue.followUp.length > 0 && <div className="queue-strip"><LoaderCircle size={13} />{runtime.queue.steering.length + runtime.queue.followUp.length} 条消息等待处理</div>}
        {runtime?.notices.at(-1) && <details className="notices"><summary>{clean(runtime.notices.at(-1)!.text).slice(0, 110)}<ChevronDown size={12} /></summary>{runtime.notices.map(n => <p key={n.id}>{clean(n.text)}</p>)}</details>}
        {runtime && (Object.keys(runtime.widgets).length > 0 || Object.keys(runtime.statuses).filter(k => k !== 'gateway-thinking').length > 0) && <details className="extension-status"><summary>扩展状态<ChevronDown size={12} /></summary><div>{Object.entries(runtime.statuses).filter(([key]) => key !== 'gateway-thinking').map(([key, value]) => <p key={key}>{clean(value)}</p>)}{Object.entries(runtime.widgets).map(([key, lines]) => <pre key={key}>{clean(lines.join('\n'))}</pre>)}</div></details>}
        <div className="composer-box">
          {images.length > 0 && <div className="attachments">{images.map((image, i) => <div className="attachment" key={i}><img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} /><span>{image.name}</span><button onClick={() => setAttachments(a => ({ ...a, [draftKey]: images.filter((_, n) => i !== n) }))} aria-label={`移除 ${image.name}`}><X size={12} /></button></div>)}</div>}
          <textarea ref={textRef} value={draft} rows={2} placeholder={isHistory ? '继续这个会话…' : cwd ? '描述你的想法，或输入 / 查看命令…' : '描述你的想法，发送时选择项目…'} aria-label="发送给 Pi 的消息" onChange={e => updateDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void send() } }} />
          {draft === '/' && commands.length > 0 && <div className="slash-menu">{commands.slice(0, 8).map(c => <button key={c.name} onClick={() => updateDraft(`/${c.name} `)}><strong>/{c.name}</strong><span>{c.description}</span></button>)}</div>}
          <div className="composer-toolbar"><div className="composer-controls"><button className="icon-button" title="添加图片" aria-label="添加图片" onClick={() => void addImages()} disabled={images.length >= 4}><ImagePlus size={18} /></button>{active.kind === 'new' && <div className="project-picker"><Folder size={14} /><select value={project} disabled={sending || savingSettings || !!loadingSettings} onChange={e => { if (e.target.value === '__add__') void chooseProject(); else setProject(e.target.value) }} aria-label="项目"><option value="">选择项目</option>{projects.map(p => <option key={p} value={p}>{nameOf(p)}</option>)}<option value="__add__">打开文件夹…</option></select></div>}
            <button className="model-button" disabled={!boot || controlsLocked} onClick={() => void openAgentSettings('models')} title={active.kind === 'new' && draftModel ? `${draftModel.provider}/${draftModel.id}` : runtime?.model ? `${runtime.model.provider}/${runtime.model.id}` : '选择本机 Pi 模型，可在发送前设置'}>{loadingSettings === 'models' || (runtime?.phase === 'starting' && !runtime.settingsOnly && !runtime.prepared) ? <><LoaderCircle className="spin" size={12} />正在加载模型…</> : (active.kind === 'new' ? draftModel?.name : undefined) || runtime?.model?.name || '选择模型'}<ChevronDown size={12} /></button>
            <button className="thinking-button" aria-label="设置思考强度" disabled={!boot || controlsLocked} onClick={() => void openAgentSettings('thinking')} title={gatewayStatus || '设置当前模型的思考强度'}>{loadingSettings === 'thinking' ? <><LoaderCircle className="spin" size={12} />正在加载…</> : thinkingLabel}<ChevronDown size={12} /></button>
            {fastAvailable && !runtime?.settingsOnly && <button className="icon-button" disabled={busy || sending} title="切换 Fast（由本机扩展决定支持情况）" aria-label="切换 Fast" onClick={() => void perform({ type: 'prompt', message: '/fast' })}><Zap size={16} /></button>}
            {commands.length > 0 && !runtime?.settingsOnly && <button className="command-button" title="命令与 Skill" onClick={() => { setModelQuery(''); setModal('commands') }}>/</button>}
          </div><div className="send-controls">{busy && <button className="stop-button" onClick={() => void perform({ type: 'stop' })} aria-label="停止并清空队列" title="停止并清空队列"><Square size={13} fill="currentColor" /></button>}<button className="send-button" disabled={sending || savingSettings || !!loadingSettings || (!draft.trim() && !images.length) || !boot} title={busy ? '发送追加指令' : '发送'} aria-label={busy ? '发送追加指令' : '发送'} onClick={() => void send()}>{sending ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={20} />}</button></div></div>
        </div>
        <div className="composer-footnote"><span>{gatewayStatus || '使用本机 Pi · 配置与会话保留在你的 Mac'}</span><div className="composer-hints"><span>↵ 发送 · ⇧ ↵ 换行</span><ContextMeter stats={runtime?.stats} modelWindow={runtime?.model?.contextWindow} connected={!!hasConnection} /></div></div>
      </div>
    </main>
    {panel && cwd && <FilePanel key={cwd} cwd={cwd} onClose={() => setPanel(false)} />}
    {revision && <Modal title={revision.mode === 'edit' ? '编辑最近一条消息' : '从这里另开分支'} onClose={() => { if (!revisionSending) setRevision(undefined) }} wide><div className="modal-body revision-editor"><p>{revision.mode === 'edit' ? '发送后将回退本轮对话，并用修改后的消息重新生成。项目文件保持现状。' : '保留原会话，将此前的对话复制到新分支。这条消息会放回输入框，准备好后再发送。项目文件保持现状。'}</p><textarea aria-label="编辑消息内容" autoFocus disabled={revisionSending} value={revision.draft.text} onChange={e => setRevision({ ...revision, draft: { ...revision.draft, text: e.target.value } })} />{revision.draft.images.length > 0 && <div className="revision-images">{revision.draft.images.map((image, i) => <img key={i} src={`data:${image.mimeType};base64,${image.data}`} alt={`保留原附件 ${i + 1}`} />)}<span>原有图片附件会保留</span></div>}{revision.error && <p className="inline-error" role="alert">{revision.error}</p>}{runtimes[revision.runtimeId]?.dialogs.map(question => <Question key={question.id} question={question} answer={response => window.desk.action(revision.runtimeId, { type: 'dialog', id: question.id, ...response })} onError={text => setRevision(value => value ? { ...value, error: text } : value)} />)}</div><footer className="modal-footer"><button className="text-button" disabled={revisionSending} onClick={() => setRevision(undefined)}>关闭</button><button className="primary-button" disabled={revisionSending || (!revision.draft.text.trim() && !revision.draft.images.length)} onClick={() => void submitRevision()}>{revisionSending ? '正在处理…' : revision.applied ? '重新发送' : revision.mode === 'edit' ? '编辑并重发' : '创建分支'}</button></footer></Modal>}
    {decision && <Modal title={decision.title} onClose={() => decide(null)}><div className="modal-body"><p>{decision.body}</p></div><footer className="modal-footer"><button className="text-button" onClick={() => decide(null)}>取消</button>{decision.options.map((o, i) => <button key={o.label} className={i === decision.options.length - 1 ? 'primary-button' : 'secondary-button'} onClick={() => decide(o.value)}>{o.label}</button>)}</footer></Modal>}
    {modal === 'settings' && boot && <SettingsModal boot={boot} save={save} refresh={reload} onClose={() => setModal(null)} onError={notify} />}
    {modal === 'catalog' && <Modal title="选择模型" wide onClose={() => setModal(null)}>
      {error && <div className="picker-error" role="alert">{error}</div>}
      <div className="modal-search"><Search size={17} /><input autoFocus placeholder="搜索模型或服务商…" value={modelQuery} onChange={e => setModelQuery(e.target.value)} /></div>
      <div className="picker-list">{matchedCatalog.map(m => <button key={`${m.provider}/${m.id}`} onClick={() => { pendingSettings.current = { model: { provider: m.provider, modelId: m.id } }; setDraftModel(m); setModal(null) }}><span><strong>{m.id}</strong><small>{m.provider}{m.name !== m.id ? ` · ${m.name}` : ''}</small></span><span className="model-meta">{m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : ''}{draftModel?.id === m.id && draftModel.provider === m.provider && <Check size={16} />}</span></button>)}
        {!matchedCatalog.length && <p className="picker-empty">{catalogModels.length ? '没有匹配的模型' : catalogReading ? '正在读取本机模型记录…' : '还没有可用的模型缓存，正在等待 Pi 返回列表。你可以关闭此窗口，稍后再选。'}</p>}
      </div>
      <footer className="picker-footer">{catalogLive ? '本机 Pi 当前列表' : catalog.source === 'cache' ? '上次加载的模型 · 发送前会确认可用性' : '最近用过的模型 · 发送前会确认可用性'} · 模型 ID A–Z{!catalogLive && !['error', 'closed'].includes(runtime?.phase || '') && (project && preparation.needsTrust ? ' · 选择项目配置后加载完整列表' : ' · 完整列表后台加载中')}{runtime && ['error', 'closed'].includes(runtime.phase) && <button className="text-button" onClick={() => void openAgentSettings('models')}>重试加载</button>}</footer>
    </Modal>}
    {(modal === 'models' || modal === 'commands') && runtime && <Modal title={modal === 'models' ? '选择模型' : '命令与 Skill'} onClose={() => { if (!savingSettings) setModal(null) }} wide>{error && <div className="picker-error" role="alert">{error}</div>}<div className="modal-search"><Search size={17} /><input autoFocus placeholder={modal === 'models' ? '搜索模型或服务商…' : '搜索命令…'} value={modelQuery} onChange={e => setModelQuery(e.target.value)} /></div><div className="picker-list">{modal === 'models' && (runtime.settingsErrors?.models || !runtime.models.length) && <div className="picker-empty"><p>{runtime.settingsErrors?.models || 'Pi 尚未返回可用模型，请检查本机模型与登录配置。'}</p><button className="secondary-button" disabled={savingSettings || busy} onClick={() => void applyAgentSetting({ type: 'refresh' }, false)}>重新加载</button></div>}{modal === 'models' && runtime.models.length > 0 && !runtime.models.some(m => matchesModel(m, modelQuery)) && <p className="picker-empty">没有匹配的模型</p>}{modal === 'models' ? runtime.models.filter(m => matchesModel(m, modelQuery)).map(m => <button key={`${m.provider}/${m.id}`} disabled={savingSettings || busy} onClick={() => void applyAgentSetting({ type: 'model', provider: m.provider, modelId: m.id })}><span><strong>{m.id}</strong><small>{m.provider}{m.name !== m.id ? ` · ${m.name}` : ''}</small></span><span className="model-meta">{m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : ''}{runtime.model?.id === m.id && runtime.model.provider === m.provider && <Check size={16} />}</span></button>) : runtime.commands.filter(c => `${c.name} ${c.description}`.toLowerCase().includes(modelQuery.toLowerCase())).map(c => <button key={c.name} onClick={() => { updateDraft(`/${c.name} `); setModal(null); textRef.current?.focus() }}><span><strong>/{c.name}</strong><small>{c.description}</small></span><span className="source-badge">{c.source}</span></button>)}</div><footer className="picker-footer">{runtime.settingsOnly ? '来自本机 Pi 全局配置' : '来自当前 Pi 会话'}{modal === 'models' ? ' · 模型 ID A–Z · 含自动发现的模型' : ' · 选择后填入输入框'}</footer></Modal>}
    {modal === 'thinking' && runtime && <Modal title="思考强度" onClose={() => { if (!savingSettings) setModal(null) }}>
      {error && <div className="picker-error" role="alert">{error}</div>}<div className="thinking-description"><strong>{runtime.model?.name || '当前模型'}</strong><p>{upstreamDefault ? '当前由上游决定推理方式。只有该模型明确支持的档位才会列出。' : budgetMode ? '当前使用网关推理预算。可选择受支持的档位，或打开网关选项调整。' : runtime.model && !runtime.model.reasoning ? '本机 Pi 未提供可调档位，这不代表上游没有思考能力。' : '档位与映射来自本机 Pi，沿用已加载的自动发现结果和手动覆盖。设置对下一条消息生效。'}</p></div>
      {runtime.settingsErrors?.thinking ? <div className="picker-empty"><p>{runtime.settingsErrors.thinking}</p><button className="secondary-button" disabled={savingSettings || busy} onClick={() => void applyAgentSetting({ type: 'refresh' }, false)}>重新加载</button></div> : <div className="picker-list thinking-options">
        {(upstreamDefault || budgetMode) && <button disabled={savingSettings || busy} onClick={() => void applyAgentSetting({ type: 'prompt', message: '/gateway-thinking default' })}><span><strong>上游默认</strong><small>由服务商决定推理方式</small></span>{upstreamDefault && <Check size={15} />}</button>}
        {thinkingChoices.map(level => <button key={level} disabled={savingSettings || busy || (thinkingChoices.length === 1 && !runtime.model?.reasoning)} onClick={() => void applyAgentSetting({ type: 'thinking', level })}><span><strong>{thinkingLabels[level] || level}</strong><small>{runtime.model?.thinkingLevelMap?.[level] && runtime.model.thinkingLevelMap[level] !== level ? `${level} → ${runtime.model.thinkingLevelMap[level]}` : level}</small></span>{!upstreamDefault && !budgetMode && runtime.thinking === level && <Check size={15} />}</button>)}
        {!thinkingChoices.length && !upstreamDefault && !budgetMode && <p className="picker-empty">当前模型未提供可选档位。</p>}
      </div>}
      <footer className="picker-footer"><button className="text-button" disabled={savingSettings || busy} onClick={() => void applyAgentSetting({ type: 'refresh' }, false)}>重新读取 Pi</button>{commands.some(c => c.name === 'gateway-model-info') && <button className="text-button" disabled={savingSettings || busy} onClick={() => { setModal(null); void perform({ type: 'prompt', message: '/gateway-model-info' }) }}>查看发现详情</button>}{gatewayAvailable && !runtime.settingsOnly && <button className="text-button" disabled={savingSettings} onClick={() => { setModal(null); void perform({ type: 'prompt', message: '/gateway-thinking' }) }}>网关推理选项…</button>}</footer>
    </Modal>}
    {modal === 'rename' && activePath && <Modal title="重命名会话" onClose={() => setModal(null)}><div className="modal-body"><input className="full-input" autoFocus maxLength={160} value={rename} onChange={e => setRename(e.target.value)} /></div><footer className="modal-footer"><button className="primary-button" disabled={!rename.trim()} onClick={() => { void window.desk.renameSession(activePath, rename.trim()).then(reload).then(() => setModal(null)).catch(notify) }}>保存</button></footer></Modal>}
  </div>
}

function SettingsModal({ boot, save, refresh, onClose, onError }: { boot: Bootstrap; save: (patch: Partial<Preferences>) => Promise<void>; refresh: () => Promise<void>; onClose: () => void; onError: (e: unknown) => void }) {
  const [values, setValues] = useState({ executable: boot.preferences.executable, node: boot.preferences.node, agentDir: boot.preferences.agentDir, sessionDir: boot.preferences.sessionDir }), [saving, setSaving] = useState(false)
  const [naming, setNaming] = useState(boot.preferences.naming), [namingModels, setNamingModels] = useState<{ provider: string; id: string }[]>([]), [loadingModels, setLoadingModels] = useState(false)
  const installation = boot.installations.find(i => i.executable === boot.preferences.executable) || boot.installations[0]
  async function choose(key: keyof typeof values) { try { const path = await window.desk.selectPath(key); if (path) setValues(v => ({ ...v, [key]: path })) } catch (e) { onError(e) } }
  async function commit() { setSaving(true); try { const patch: Partial<Preferences> = { naming }; for (const key of Object.keys(values) as (keyof typeof values)[]) if (values[key] !== boot.preferences[key]) patch[key] = values[key]; await save(patch); await refresh(); onClose() } catch (e) { onError(e) } finally { setSaving(false) } }
  return <Modal title="设置" wide onClose={onClose}><div className="settings-body"><div className="settings-intro"><Mark /><div><h3>你的 Pi，新的工作界面。</h3><p>Pi Desk 使用这台 Mac 上的 Pi 和现有配置。</p></div><span className="version-pill">0.2.7</span></div>
    <div className="setting-section"><h4>外观</h4><div className="theme-options">{(['light', 'dark', 'system'] as const).map(theme => <button key={theme} className={boot.preferences.theme === theme ? 'selected' : ''} onClick={() => void save({ theme }).catch(onError)}><span className={`theme-sample ${theme}`} /><span>{theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统'}</span>{boot.preferences.theme === theme && <Check size={13} />}</button>)}</div></div>
    <div className="setting-section"><h4>本机 Pi <span className={installation?.compatible ? 'installed-pill' : 'missing-pill'}>{installation?.compatible ? `已发现 ${installation.version}` : '需要 Pi 0.85.1+'}</span></h4><p className="setting-description">留空时自动查找安装位置。更改路径前，请先结束 Pi Desk 中的连接。</p>
      {([{ key: 'executable', label: 'Pi 入口', placeholder: installation?.executable || '自动查找本机 Pi' }, { key: 'node', label: 'Node.js', placeholder: installation?.node || '自动查找 Node.js' }, { key: 'agentDir', label: '配置目录', placeholder: '~/.pi/agent' }, { key: 'sessionDir', label: '会话目录', placeholder: '沿用 Pi 配置' }] as const).map(field => <label className="path-setting" key={field.key}><span>{field.label}</span><div><input value={values[field.key]} placeholder={field.placeholder} onChange={e => setValues(v => ({ ...v, [field.key]: e.target.value }))} /><button onClick={() => void choose(field.key)} aria-label={`选择${field.label}`}><FolderOpen size={16} /></button></div></label>)}
      {!installation && <p className="install-help">尚未安装 Pi？在终端运行 <code>npm install -g @earendil-works/pi-coding-agent</code>，完成 Pi 配置后回到这里刷新。</p>}
    </div>
    <div className="setting-section setting-naming"><h4>会话自动命名</h4><p className="setting-description">新对话完成后，用独立模型生成简短标题。仅发送最多 4,000 字的用户对话片段；不发送工具输出或附件。名称保存在 Pi Desk，可随时手动修改。支持本机 Pi 配置的 OpenAI 兼容服务商。</p>
      <label className="setting-description"><input type="checkbox" checked={naming.enabled} onChange={e => setNaming(n => ({ ...n, enabled: e.target.checked }))} /> 自动为新会话命名</label>
      <label className="path-setting"><span>服务商</span><div><input value={naming.provider} placeholder="Pi 服务商 ID" onChange={e => { setNaming(n => ({ ...n, provider: e.target.value })); setNamingModels([]) }} /></div></label>
      <label className="path-setting"><span>命名模型</span><div><input list="naming-models" value={naming.modelId} placeholder="模型完整 ID" onChange={e => setNaming(n => ({ ...n, modelId: e.target.value }))} /><datalist id="naming-models">{namingModels.map(m => <option key={m.id} value={m.id} />)}</datalist></div></label>
      <div className="setting-links"><button disabled={loadingModels || !naming.provider.trim()} onClick={() => { setLoadingModels(true); void save({ naming }).then(() => window.desk.namingModels()).then(setNamingModels).catch(onError).finally(() => setLoadingModels(false)) }}>{loadingModels ? '正在读取模型…' : '读取该服务商的模型'}</button><button disabled={boot.namingStatus.running || !naming.provider.trim() || !naming.modelId.trim()} onClick={() => { void save({ naming }).then(() => window.desk.nameSessions()).catch(onError) }}>为未命名历史会话生成标题</button>{boot.namingStatus.running && <button onClick={() => void window.desk.cancelNaming().catch(onError)}>停止命名</button>}</div>
      {(boot.namingStatus.running || boot.namingStatus.total > 0 || boot.namingStatus.error) && <p className="naming-progress" role="status">{boot.namingStatus.running ? '正在命名' : '命名已结束'} · 完成 {boot.namingStatus.completed} / {boot.namingStatus.total} · 失败 {boot.namingStatus.failed} · 跳过 {boot.namingStatus.skipped}{boot.namingStatus.error && <><br />{boot.namingStatus.error}</>}</p>}
    </div>
    <div className="setting-section"><h4>会话与隐私</h4><p className="setting-description">历史浏览只读。模型、认证和扩展仍由 Pi 管理；Pi Desk 单独保存界面偏好与草稿。首版支持 npm 安装的本地 Pi，部分终端专用面板暂不支持。</p><div className="setting-links"><button onClick={() => void refresh().catch(onError)}>刷新本机信息</button><button onClick={() => void window.desk.selectPath('session').then(() => refresh()).catch(onError)}>添加其他会话文件</button></div>{boot.warnings.map(w => <p key={w}>{w}</p>)}</div>
  </div><footer className="modal-footer"><button className="text-button" onClick={onClose}>关闭</button><button className="primary-button" disabled={saving} onClick={() => void commit()}>{saving ? '正在保存…' : '保存设置'}</button></footer></Modal>
}
