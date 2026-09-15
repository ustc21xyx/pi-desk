import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, shell, type IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'node:fs'
import { join, resolve, relative, isAbsolute, extname, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Storage, expand } from './storage'
import { discover } from './discovery'
import { PiRuntime } from './runtime'
import { NamingService } from './naming'
import { readReview, revertReview } from './review'
import { AppUpdates } from './updates'
import { fileReferences } from './file-index'
import { RecoveryStore } from './recovery'
import { DesktopNotifications, hasPiNotificationScript } from './desktop-notifications'
import type { Preferences, RuntimeAction } from '../shared/contracts'

const exec = promisify(execFile)
app.setName('Pi Desk')
protocol.registerSchemesAsPrivileged([{ scheme: 'desk', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
let win: BrowserWindow | null = null
let store: Storage
let naming: NamingService
let updates: AppUpdates
let recovery: RecoveryStore
let pendingNavigation: string | undefined
const notifications = new DesktopNotifications(() => win, id => { pendingNavigation = id; if (!win) createWindow(); win?.show(); win?.focus(); send('desk:navigate', id) })
let installingUpdate = false
let activeRequests = 0
const autoNamed = new Set<string>()
const runtimes = new Map<string, PiRuntime>()
let preparingSettings: Promise<string> | undefined
let preparingProject: Promise<void> = Promise.resolve()
const settingsDirectories = new Set<string>()
let quitting = false
const live = () => [...runtimes.values()].filter(r => !['closed', 'error'].includes(r.snapshot.phase))
const text = (v: unknown, max = 10000) => { if (typeof v !== 'string' || v.length > max || v.includes('\0')) throw new Error('无效输入。'); return v }
const object = (v: unknown): Record<string, any> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('无效请求。'); return v as Record<string, any> }
const send = (channel: string, value: unknown) => { if (win && !win.isDestroyed()) win.webContents.send(channel, value) }

function isAppURL(url: string) {
  const dev = process.env.ELECTRON_RENDERER_URL
  try {
    const parsed = new URL(url)
    if (dev && !app.isPackaged) return parsed.origin === new URL(dev).origin
    return parsed.protocol === 'desk:' && parsed.hostname === 'app' && !parsed.username && !parsed.password && !parsed.port
  } catch { return false }
}
function handle(name: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(`desk:${name}`, async (event: IpcMainInvokeEvent, ...args) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !isAppURL(event.senderFrame.url)) throw new Error('请求来源无效。')
    if (installingUpdate && name !== 'updateState') throw new Error('正在准备重启安装，请稍候。')
    activeRequests++
    try { return await fn(...args) } finally { activeRequests-- }
  })
}
async function inProject(cwd: unknown, subpath: unknown) {
  const root = await store.authorizeProject(text(cwd)), target = await fs.realpath(resolve(root, text(subpath)))
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('文件不在当前项目内。')
  return { root, target }
}
function validateAction(input: unknown): RuntimeAction {
  const a = object(input), type = text(a.type, 30)
  if (['clearQueue', 'stop', 'refresh', 'compact', 'close', 'activate'].includes(type)) return { type } as RuntimeAction
  if (type === 'prompt') {
    const message = text(a.message, 1_000_000)
    if (a.behavior !== undefined && !['steer', 'followUp'].includes(a.behavior)) throw new Error('队列模式无效。')
    let images: { type: 'image'; data: string; mimeType: string }[] | undefined
    if (a.images !== undefined) {
      if (!Array.isArray(a.images) || a.images.length > 4) throw new Error('每次最多添加 4 张图片。')
      images = a.images.map((v: unknown) => { const im = object(v); if (!/^image\/(png|jpeg|webp|gif)$/.test(im.mimeType)) throw new Error('图片格式无效。'); return { type: 'image' as const, data: text(im.data, 12_000_000), mimeType: im.mimeType } })
      if (images.reduce((n, im) => n + im.data.length, 0) > 24_000_000) throw new Error('附件总大小超过限制。')
    }
    if (!message.trim() && !images?.length) throw new Error('请输入内容。')
    return { type, message, behavior: a.behavior, images }
  }
  if (type === 'model') return { type, provider: text(a.provider, 300), modelId: text(a.modelId, 1000) }
  if (type === 'thinking') { const level = text(a.level, 30); if (!['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)) throw new Error('推理档位无效。'); return { type, level } }
  if (type === 'rename') return { type, name: text(a.name, 160) }
  if (type === 'dialog') return { type, id: text(a.id, 100), value: a.value === undefined ? undefined : text(a.value, 1_000_000), confirmed: a.confirmed === true, cancelled: a.cancelled === true }
  throw new Error('不支持的操作。')
}
async function localInstallation() {
  const installations = await discover(store.preferences)
  const installation = store.preferences.executable ? installations.find(i => i.executable === expand(store.preferences.executable)) : installations.find(i => i.compatible) || installations[0]
  if (!installation) throw new Error('没有找到本机 Pi，请先在设置中选择安装位置。')
  if (!installation.compatible) throw new Error('首版需要可识别的 Pi 0.85.1 或更新版本。请指定 npm 安装的 Pi 入口或升级 Pi。')
  return installation
}
async function startProject(input: unknown) {
  const v = object(input), cwd = await store.authorizeProject(text(v.cwd))
  if (v.prepared !== undefined && typeof v.prepared !== 'boolean') throw new Error('准备连接参数无效。')
  if (v.prepared && v.sessionPath !== undefined) throw new Error('历史会话必须明确继续，不能提前加载。')
  const path = v.sessionPath === undefined ? undefined : text(v.sessionPath)
  if (path) {
    const metadata = store.knownSessions.get(path)
    if (!metadata || await fs.realpath(metadata.cwd) !== cwd) throw new Error('会话与所选项目不匹配。')
    const existing = live().find(r => r.snapshot.sessionPath === path)
    if (existing) return existing.snapshot.id
  }
  const trust = await store.trust(cwd)
  if (v.trust !== undefined && typeof v.trust !== 'boolean') throw new Error('信任选择无效。')
  if (trust.needsDecision && typeof v.trust !== 'boolean') throw new Error('请先选择是否加载项目配置。')
  if (v.prepared) {
    const existing = live().find(r => r.snapshot.prepared && r.snapshot.cwd === cwd && r.preparationTrust === v.trust)
    if (existing) return existing.snapshot.id
    // Keep at most one unused project connection. Active conversations are never evicted.
    await Promise.all(live().filter(r => r.snapshot.prepared).map(r => r.close()))
  }
  const installation = await localInstallation()
  const agentDir = await store.root()
  const sessionDir = store.preferences.sessionDir ? await store.sessionRoot() : undefined
  const externalNotifications = await hasPiNotificationScript(agentDir, cwd, v.trust === true || !trust.needsDecision)
  const runtime = new PiRuntime(cwd, snapshot => {
    const path = snapshot.sessionPath
    if (path && store.titles[path]) snapshot.title = store.titles[path].title
    recovery.observe(snapshot)
    notifications.observe(snapshot, store.preferences.desktopNotifications, externalNotifications)
    send('desk:runtime', snapshot)
    const key = `${snapshot.id}:${path}`
    if (path && store.preferences.naming.enabled && snapshot.phase === 'idle' && snapshot.completedRuns > 0 && snapshot.messages.some(m => m.role === 'assistant') && !autoNamed.has(key)) {
      autoNamed.add(key)
      void store.index().then(() => naming.name(path)).catch(e => { runtime.notice(`自动命名未完成：${e.message}`, 'warning') })
    }
  }, (id, text) => send('desk:editor', { id, text }), path)
  runtime.snapshot.prepared = v.prepared === true
  runtime.preparationTrust = v.trust
  if (quitting) throw new Error('应用正在退出。')
  runtimes.set(runtime.snapshot.id, runtime)
  const bridge = app.isPackaged ? join(process.resourcesPath, 'desk-bridge.mjs') : join(app.getAppPath(), 'resources/desk-bridge.mjs')
  void runtime.start(installation, agentDir, sessionDir, bridge, v.trust)
  return runtime.snapshot.id
}
function registerIPC() {
  handle('updateState', () => updates.state)
  handle('checkUpdate', () => updates.check())
  handle('downloadUpdate', () => updates.fetchUpdate())
  handle('cancelUpdateDownload', () => updates.cancelDownload())
  handle('installUpdate', async () => {
    if (updates.state.phase !== 'ready') throw new Error('请先下载更新。')
    const busy = () => activeRequests > 1 || naming.busy || [...runtimes.values()].some(r => r.busy)
    if (busy()) throw new Error('还有任务或配置加载正在进行，请等它们完成后再点击重启安装。')
    installingUpdate = true
    let prepared: Awaited<ReturnType<AppUpdates['stage']>> | undefined
    try {
      prepared = await updates.stage()
      await Promise.allSettled([preparingProject, preparingSettings])
      if (busy()) throw new Error('还有任务正在进行，暂时不能重启安装。')
      // Stop accepting work before closing idle connections; never interrupt an active task.
      await Promise.all([...runtimes.values()].map(r => r.close()))
      await updates.handoff(prepared)
      await recovery.flushAll()
      naming.close()
      quitting = true
      app.quit()
    } catch (error) {
      installingUpdate = false
      await updates.cancelInstall(prepared)
      throw error
    }
  })
  handle('revisionDraft', (id, entryId) => {
    const runtime = runtimes.get(text(id, 100)); if (!runtime) throw new Error('连接不存在。')
    return runtime.revisionDraft(text(entryId, 100))
  })
  handle('revise', (id, entryId, mode, input) => {
    const runtime = runtimes.get(text(id, 100)); if (!runtime) throw new Error('连接不存在。')
    if (mode !== 'edit' && mode !== 'fork') throw new Error('编辑方式无效。')
    const action = mode === 'edit' ? validateAction({ ...object(input), type: 'prompt' }) : undefined
    return runtime.revise(text(entryId, 100), mode, action?.type === 'prompt' ? action : undefined)
  })
  handle('review', async cwd => readReview(await store.authorizeProject(text(cwd))))
  handle('revert', async (cwd, snapshotId, staged, fileId, hunkId) => {
    const root = await store.authorizeProject(text(cwd))
    if (typeof staged !== 'boolean') throw new Error('差异类型无效。')
    if (live().some(r => !r.snapshot.settingsOnly && !r.snapshot.prepared && !['idle', 'error', 'closed'].includes(r.snapshot.phase) && (r.snapshot.cwd === root || r.snapshot.cwd.startsWith(root + '/') || root.startsWith(r.snapshot.cwd + '/')))) throw new Error('项目中还有 Pi 任务运行，请先停止或等待完成。')
    return revertReview(root, text(snapshotId, 100), staged, fileId === undefined ? undefined : text(fileId, 100), hunkId === undefined ? undefined : text(hunkId, 100))
  })
  handle('modelCatalog', () => store.modelCatalog())
  handle('defaultModel', () => store.defaultModel())
  handle('prepareSettings', async () => {
    if (preparingSettings) return preparingSettings
    const existing = live().find(r => r.snapshot.settingsOnly)
    if (existing) return existing.snapshot.id
    preparingSettings = (async () => {
      const installation = await localInstallation()
      const agentDir = await store.root()
      const catalogScope = await store.catalogScope()
      const cwd = await fs.mkdtemp(join(app.getPath('temp'), 'pi-desk-settings-'))
      settingsDirectories.add(cwd)
      const runtime = new PiRuntime(cwd, snapshot => {
        send('desk:runtime', snapshot)
        if (snapshot.models.length && !snapshot.settingsErrors?.models) void store.cacheModels(snapshot.models, catalogScope).catch(() => {})
      }, () => {})
      runtime.snapshot.settingsOnly = true
      runtimes.set(runtime.snapshot.id, runtime)
      const bridge = app.isPackaged ? join(process.resourcesPath, 'desk-bridge.mjs') : join(app.getAppPath(), 'resources/desk-bridge.mjs')
      void runtime.start(installation, agentDir, undefined, bridge, false)
      return runtime.snapshot.id
    })().finally(() => { preparingSettings = undefined })
    return preparingSettings
  })
  handle('bootstrap', async () => ({ navigateTo: pendingNavigation, version: app.getVersion(), defaultModel: await store.defaultModel(), preferences: store.preferences, namingStatus: naming.status, installations: await discover(store.preferences), ...await store.index(), runtimes: [...runtimes.values()].map(r => r.snapshot) }))
  handle('selectPath', async kind => {
    if (!['project', 'executable', 'node', 'agentDir', 'sessionDir', 'session'].includes(kind)) throw new Error('无效路径类型。')
    const directory = ['project', 'agentDir', 'sessionDir'].includes(kind)
    const result = await dialog.showOpenDialog(win!, { title: { project: '选择项目文件夹', executable: '选择 Pi 可执行文件', node: '选择 Node.js', agentDir: '选择 Pi 配置目录', sessionDir: '选择 Pi 会话目录', session: '打开 Pi 会话' }[kind as string], properties: directory ? ['openDirectory'] : ['openFile'], ...(kind === 'session' ? { filters: [{ name: 'Pi 会话', extensions: ['jsonl'] }] } : {}) })
    if (result.canceled || !result.filePaths[0]) return null
    const path = await fs.realpath(result.filePaths[0]); store.approvedPaths.add(path)
    if (kind === 'project') await store.save({ projects: [...new Set([...store.preferences.projects, path])] })
    if (kind === 'session') await store.index()
    return path
  })
  handle('savePreferences', async input => {
    const v = object(input), patch: Partial<Preferences> = {}
    for (const key of ['executable', 'node', 'agentDir', 'sessionDir'] as const) {
      if (v[key] !== undefined) {
        if (live().some(r => !r.snapshot.settingsOnly && !r.snapshot.prepared) || naming.status.running) throw new Error('请先关闭 Pi 连接，再修改内核或配置路径。')
        if (preparingSettings) await preparingSettings
        await preparingProject
        await Promise.all(live().filter(r => r.snapshot.settingsOnly || r.snapshot.prepared).map(r => r.close()))
        patch[key] = text(v[key], 4096)
        if (key === 'agentDir' && !patch[key]) throw new Error('配置目录不能为空。')
      }
    }
    if (v.naming !== undefined) { const n = object(v.naming); if (naming.status.running && JSON.stringify(n) !== JSON.stringify(store.preferences.naming)) throw new Error('请先停止历史命名，再更换命名设置。'); if (typeof n.enabled !== 'boolean') throw new Error('命名开关无效。'); patch.naming = { enabled: n.enabled, provider: text(n.provider, 300).trim(), modelId: text(n.modelId, 1000).trim() } }
    if (v.desktopNotifications !== undefined) { if (typeof v.desktopNotifications !== 'boolean') throw new Error('通知选项无效。'); patch.desktopNotifications = v.desktopNotifications }
    if (v.theme !== undefined) { if (!['light', 'dark', 'system'].includes(v.theme)) throw new Error('主题无效。'); patch.theme = v.theme }
    for (const key of ['archived', 'pinned'] as const) if (v[key] !== undefined) { if (!Array.isArray(v[key]) || v[key].length > 5000) throw new Error('会话列表无效。'); patch[key] = v[key].map((s: unknown) => text(s, 4096)) }
    return store.save(patch)
  })
  handle('namingModels', () => naming.models())
  handle('nameSessions', () => { void naming.batch() })
  handle('cancelNaming', () => naming.cancel())
  handle('renameSession', async (path, title) => {
    path = text(path); title = text(title, 160).trim()
    if (!store.knownSessions.has(path) || !title) throw new Error('会话或名称无效。')
    await store.setTitle(path, title, 'manual')
    for (const r of runtimes.values()) if (r.snapshot.sessionPath === path) { r.snapshot.title = title; r.emit() }
  })
  handle('projectTrust', cwd => store.trust(text(cwd)))
  handle('viewing', id => {
    notifications.viewing = id === null ? null : text(id, 100)
    if (notifications.viewing === pendingNavigation) pendingNavigation = undefined
    const runtime = id && runtimes.get(id)
    if (runtime && notifications.visible(id)) { runtime.snapshot.unread = undefined; runtime.emit() }
  })
  handle('history', async (path, before) => {
    path = text(path)
    if (!store.knownSessions.has(path) && [...runtimes.values()].some(r => r.snapshot.sessionPath === path)) await store.index()
    return store.historyPage(path, before === undefined ? undefined : text(before, 100))
  })
  handle('recovery', async path => {
    path = text(path)
    if (!store.knownSessions.has(path)) return undefined
    return recovery.read(path, (await store.history(path, false)).messages)
  })
  handle('dismissRecovery', path => {
    path = text(path)
    if (!store.knownSessions.has(path)) throw new Error('会话不存在。')
    return recovery.dismiss(path)
  })
  handle('fileReferences', async (cwd, query) => fileReferences(await store.authorizeProject(text(cwd)), text(query, 300)))
  handle('start', async input => {
    if (object(input).prepared !== true) return startProject(input)
    const request = preparingProject.then(() => startProject(input))
    preparingProject = request.then(() => {}, () => {})
    return request
  })
  handle('action', async (id, input) => {
    const runtime = runtimes.get(text(id, 100)); if (!runtime) throw new Error('连接不存在。')
    await runtime.act(validateAction(input))
  })
  handle('pickImages', async () => {
    const result = await dialog.showOpenDialog(win!, { title: '添加图片', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] })
    if (result.canceled) return []
    if (result.filePaths.length > 4) throw new Error('每次最多添加 4 张图片。')
    const images = []
    for (const path of result.filePaths) {
      const stat = await fs.stat(path); if (stat.size > 8 * 1024 * 1024) throw new Error('单张图片不能超过 8 MB。')
      const ext = extname(path).toLowerCase(); const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' } as Record<string, string>)[ext]
      if (!mime) throw new Error('不支持该图片格式。')
      images.push({ type: 'image', name: path.split('/').at(-1), mimeType: mime, data: (await fs.readFile(path)).toString('base64') })
    }
    return images
  })
  handle('files', async (cwd, path) => {
    const { root, target } = await inProject(cwd, path)
    const entries = await fs.readdir(target, { withFileTypes: true })
    return entries.filter(e => !e.isSymbolicLink() && !['.git', 'node_modules', '.DS_Store'].includes(e.name)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, 500).map(e => ({ name: e.name, path: relative(root, join(target, e.name)), directory: e.isDirectory() }))
  })
  handle('readFile', async (cwd, path) => {
    const { target } = await inProject(cwd, path), stat = await fs.stat(target)
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('首版支持预览 1 MB 以内的文本文件。')
    const content = await fs.readFile(target)
    if (content.includes(0)) throw new Error('此文件不是可预览的文本。')
    return content.toString('utf8')
  })
  handle('diff', async cwd => {
    const root = await store.authorizeProject(text(cwd))
    const base = ['--no-pager', '-c', 'core.fsmonitor=false', '-C', root, 'diff', '--no-ext-diff', '--no-textconv', '--no-color']
    try { return (await exec('/usr/bin/git', [...base, 'HEAD', '--'], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 })).stdout }
    catch { try { return (await exec('/usr/bin/git', [...base, '--'], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 })).stdout } catch { throw new Error('无法读取 Git 差异。请确认项目是 Git 仓库且输出未超过 2 MB。') } }
  })
  handle('copyText', value => { clipboard.writeText(text(value, 1_000_000)) })
  handle('openExternal', async value => {
    const url = new URL(text(value, 8000))
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持打开普通网页链接。')
    await shell.openExternal(url.href)
  })
}
function createWindow() {
  win = new BrowserWindow({ width: 1340, height: 900, minWidth: 920, minHeight: 640, title: 'Pi Desk', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 }, backgroundColor: '#f8f8f6', show: false, webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => { if (!isAppURL(url)) event.preventDefault() })
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  win.webContents.session.setPermissionCheckHandler(() => false)
  win.once('ready-to-show', () => win?.show())
  win.on('close', event => { if (!quitting && live().some(r => !r.snapshot.settingsOnly && !r.snapshot.prepared && r.snapshot.phase !== 'idle')) { event.preventDefault(); win?.hide() } })
  win.on('focus', () => { const runtime = notifications.viewing && runtimes.get(notifications.viewing); if (runtime) { runtime.snapshot.unread = undefined; runtime.emit() } })
  win.on('closed', () => { win = null })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadURL('desk://app/index.html')
}
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
else {
  app.on('second-instance', () => { if (!win) createWindow(); win?.show(); win?.focus() })
  void app.whenReady().then(async () => {
    store = new Storage(app.getPath('userData')); await store.init()
    recovery = new RecoveryStore(join(app.getPath('userData'), 'recovery'))
    updates = new AppUpdates(state => send('desk:update', state))
    naming = new NamingService(store, app.isPackaged ? join(process.resourcesPath, 'naming-provider.mjs') : join(app.getAppPath(), 'resources/naming-provider.mjs'), status => send('desk:naming', status), (path, title) => {
      for (const r of runtimes.values()) if (r.snapshot.sessionPath === path) { r.snapshot.title = title; r.emit() }
      send('desk:naming', naming.status)
    })
    protocol.handle('desk', request => {
      const url = new URL(request.url)
      if (url.hostname !== 'app') return new Response('Not found', { status: 404 })
      const root = resolve(__dirname, '../renderer'), path = resolve(root, '.' + decodeURIComponent(url.pathname))
      const rel = relative(root, path)
      if (rel.startsWith('..') || isAbsolute(rel)) return new Response('Forbidden', { status: 403 })
      return net.fetch(pathToFileURL(path).href)
    })
    registerIPC()
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Pi Desk', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }
    ]))
    createWindow()
    app.on('activate', () => { if (!win) createWindow(); win?.show() })
  })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault()
    if (installingUpdate) return
    void (async () => {
      if (live().some(r => !r.snapshot.settingsOnly && !r.snapshot.prepared && r.snapshot.phase !== 'idle')) {
        const response = await dialog.showMessageBox({ type: 'question', title: '退出 Pi Desk？', message: '还有 Pi 任务正在运行', detail: '退出会结束 Pi Desk 启动的任务。已保存的会话仍保留在本机 Pi 中。', buttons: ['继续工作', '结束任务并退出'], defaultId: 0, cancelId: 0 })
        if (response.response === 0) return
      }
      naming.close()
      quitting = true
      await Promise.allSettled([preparingProject, preparingSettings])
      for (const r of runtimes.values()) recovery.observe(r.snapshot)
      await recovery.flushAll()
      await Promise.all([...runtimes.values()].map(r => r.close()))
      await recovery.flushAll()
      await Promise.all([...settingsDirectories].map(path => fs.rm(path, { recursive: true, force: true }).catch(() => {})))
      app.quit()
    })()
  })
}
