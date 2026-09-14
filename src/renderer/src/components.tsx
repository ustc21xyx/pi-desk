import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, Check, ChevronDown, ChevronRight, Copy, FileCode2, Folder, GitBranch, Pencil, LoaderCircle, Terminal, X } from 'lucide-react'
import { ReviewPanel } from './ReviewPanel'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough/parseOnly'
import type { DisplayMessage, ExtensionDialog, FileItem, RuntimeSnapshot } from '../../shared/contracts'

export const nameOf = (path: string) => path.split('/').filter(Boolean).at(-1) || path
export const clean = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '')
export const phaseLabels: Record<RuntimeSnapshot['phase'], string> = { starting: '正在连接', idle: '已就绪', running: '正在工作', waiting: '等待你的回答', retrying: '正在重试', compacting: '正在整理上下文', error: '连接异常', closed: '已断开' }
export function Mark({ small = false }: { small?: boolean }) { return <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M7 10h18M11 11v12m10-12v12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /><path d="M7 26h18" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".35" /></svg></span> }
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} onCancel={e => { e.preventDefault(); onClose() }} aria-label={title} onClick={e => { if (e.target === ref.current) onClose() }}>
    <header className="modal-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>{children}
  </dialog>
}
// Parse CJK emphasis before React rendering; preserve source text, code and escapes.
const markdownPlugins = [remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough]
export function RichText({ text }: { text: string }) {
  return <Markdown remarkPlugins={markdownPlugins} skipHtml components={{
    a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:\/\//.test(href)) void window.desk.openExternal(href).catch(() => {}) }} title={href}>{children}</a>,
    img: ({ alt }) => <span className="image-placeholder">[图片{alt ? `：${alt}` : ''}]</span>
  }}>{text}</Markdown>
}
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return <button className="icon-button copy" aria-label="复制内容" title={copied ? '已复制' : '复制'} onClick={() => void window.desk.copyText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800) })}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
}
function duration(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
function toolPreview(args: string) {
  try { const value = JSON.parse(args); return clean(String(value.command || value.cmd || value.path || value.file_path || '')).replace(/\s+/g, ' ').slice(0, 180) } catch { return '' }
}
export function Transcript({ messages, runtime, onRevise, revisionDisabled }: { messages: DisplayMessage[]; runtime?: RuntimeSnapshot; onRevise: (message: DisplayMessage, mode: 'edit' | 'fork') => void; revisionDisabled: boolean }) {
  const ref = useRef<HTMLDivElement>(null), stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  useEffect(() => { if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [messages, runtime])
  const toolIds = new Set(messages.flatMap(m => m.blocks.filter(b => b?.type === 'toolCall').map(b => b.id)))
  const results = new Map(messages.filter(m => m.role === 'toolResult').map(m => [m.toolCallId, m]))
  const lastUser = messages.findLast(m => m.role === 'user')
  const renderMessage = (message: DisplayMessage, process = false) => {
    if (message.role === 'toolResult' && toolIds.has(message.toolCallId)) return null
    const isUser = message.role === 'user'
    if (!message.blocks.length && !message.error) return null
    return <article className={`message ${isUser ? 'user-message' : 'assistant-message'} ${process ? 'process-message' : ''}`} key={message.id}>
      <div className="message-body">{message.blocks.map((block, index) => {
        if (!block) return null
        if (block.type === 'thinking') return <details className="thinking" key={index}><summary><ChevronRight size={13} />思考过程</summary><div className="markdown"><RichText text={block.text || ''} /></div></details>
        if (block.type === 'image') return <img className="message-image" key={index} src={`data:${block.mimeType};base64,${block.data}`} alt="会话附件" />
        if (block.type === 'toolCall') {
          const activity = runtime?.tools[block.id || ''], result = results.get(block.id)
          const output = activity?.output || result?.blocks.filter(b => b.type === 'text').map(b => b.text).join('\n') || ''
          const failed = activity?.status === 'error' || result?.isError
          const args = activity?.args || block.arguments || '', preview = toolPreview(args)
          return <details className={`tool-card ${failed ? 'failed' : ''}`} key={block.id || index}><summary>
            {activity?.status === 'running' ? <LoaderCircle className="spin" size={13} /> : <Terminal size={13} />}<span>{block.name || '工具调用'}</span><code className="tool-preview" title={preview}>{preview}</code><span className="tool-status">{failed ? '执行出错' : activity?.status === 'running' ? '执行中' : result || activity ? '已完成' : '准备执行'}</span><ChevronDown size={12} />
          </summary><div className="tool-content"><div className="tool-label">输入</div><pre>{clean(args)}</pre>{output && <><div className="tool-label">输出</div><pre>{clean(output)}</pre></>}</div></details>
        }
        return <div className={isUser ? 'user-text' : 'markdown'} key={index}>{isUser ? block.text : <RichText text={clean(block.text || '')} />}</div>
      })}{message.error && <div className="inline-error">{message.error}</div>}</div>
      {!isUser && !process && !message.streaming && message.blocks.some(b => b.type === 'text' && b.text) && <CopyButton text={message.blocks.filter(b => b.type === 'text').map(b => b.text).join('\n')} />}
      {isUser && message.entryId && <div className="message-actions">{message.id === lastUser?.id && <button disabled={revisionDisabled} title="编辑最近一条消息，文件改动保持现状" onClick={() => onRevise(message, 'edit')}><Pencil size={12} />编辑并重发</button>}<button disabled={revisionDisabled} title="从这条消息另开分支，保留原会话" onClick={() => onRevise(message, 'fork')}><GitBranch size={12} />从这里分支</button></div>}
    </article>
  }
  const turns: { user?: DisplayMessage; messages: DisplayMessage[] }[] = []
  for (const message of messages) {
    if (message.role === 'user') turns.push({ user: message, messages: [] })
    else { if (!turns.length) turns.push({ messages: [] }); turns.at(-1)!.messages.push(message) }
  }
  return <div className="transcript-wrap"><div className="transcript" ref={ref} onScroll={() => { const el = ref.current!; const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100; stick.current = bottom; setAtBottom(bottom) }}>
    <div className="message-column">{turns.map((turn, index) => {
      const tail = turn.messages.at(-1)
      const live = index === turns.length - 1 && runtime && !['idle', 'error', 'closed'].includes(runtime.phase)
      const final = !live && tail?.role === 'assistant' && !tail.streaming && !tail.error && !['error', 'aborted', 'toolUse', 'length'].includes(tail.stopReason || '') && !tail.blocks.some(b => b.type === 'toolCall') && tail.blocks.some(b => b.type === 'text' && b.text) ? tail : undefined
      const steps = final ? [...turn.messages.slice(0, -1), ...(final.blocks.some(b => b.type === 'thinking') ? [{ ...final, id: `${final.id}-thought`, blocks: final.blocks.filter(b => b.type === 'thinking') }] : [])] : []
      const visibleSteps = steps.filter(m => !(m.role === 'toolResult' && toolIds.has(m.toolCallId)) && (m.blocks.length || m.error))
      const start = turn.user?.timestamp || turn.messages[0]?.timestamp, end = final?.completedAt || final?.timestamp
      const elapsed = start && end && end >= start ? end - start : undefined
      const calls = steps.reduce((n, m) => n + m.blocks.filter(b => b.type === 'toolCall').length, 0)
      return <Fragment key={turn.user?.id || `leading-${index}`}>{turn.user && renderMessage(turn.user)}
        {final ? <>{visibleSteps.length > 0 ? <details className="turn-process"><summary><ChevronRight size={13} /><span>工作过程{elapsed !== undefined ? ` · 用时约 ${duration(elapsed)}` : ''}</span>{calls > 0 && <span className="process-count">{calls} 次工具调用</span>}</summary><div className="process-content">{steps.map(m => renderMessage(m, true))}</div></details> : elapsed !== undefined && <div className="turn-duration">用时约 {duration(elapsed)}</div>}{renderMessage({ ...final, blocks: final.blocks.filter(b => b.type !== 'thinking') })}</> : turn.messages.map(m => renderMessage(m, true))}
      </Fragment>
    })}
      {runtime && !['idle', 'error', 'closed', 'starting'].includes(runtime.phase) && <div className="working"><span className="working-orbit" />{phaseLabels[runtime.phase]}</div>}
    </div>
  </div>{!atBottom && <button className="jump-bottom" onClick={() => { stick.current = true; ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' }); setAtBottom(true) }}><ArrowDown size={15} />最新消息</button>}</div>
}
export function ContextMeter({ stats, modelWindow, connected }: { stats?: RuntimeSnapshot['stats']; modelWindow?: number; connected: boolean }) {
  const known = typeof stats?.contextPercent === 'number' && Number.isFinite(stats.contextPercent)
  const percent = known ? stats!.contextPercent! : undefined
  const capacity = stats?.contextWindow || modelWindow
  const used = stats?.contextTokens
  const label = percent === undefined ? '—' : percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`
  const detail = percent === undefined ? connected ? '上下文用量待更新' : '连接后显示上下文用量' : `上下文已用 ${percent.toFixed(1)}%`
  const tokens = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value).toLocaleString('zh-CN')} tokens` : '待更新'
  return <details className={`context-meter ${!known ? 'unknown' : percent! >= 95 ? 'critical' : percent! >= 80 ? 'warning' : ''}`}>
    <summary aria-label={detail} title={detail}><svg viewBox="0 0 24 24" aria-hidden="true"><circle className="context-track" cx="12" cy="12" r="9" /><circle className="context-progress" cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${Math.min(100, Math.max(0, percent || 0))} 100`} transform="rotate(-90 12 12)" /></svg><span>{label}</span></summary>
    <div className="context-popover"><strong>上下文窗口</strong><dl><dt>当前占用</dt><dd>{tokens(used)}</dd><dt>窗口容量</dt><dd>{tokens(capacity)}</dd><dt>占用比例</dt><dd>{percent === undefined ? '待更新' : `${percent.toFixed(1)}%`}</dd></dl><p>{percent === undefined ? connected ? 'Pi 尚未返回有效用量；上下文压缩后，会在新的模型回复后更新。' : '选择模型或发送消息，连接本机 Pi 后显示。' : '本次上下文的估算占用，随每轮回复更新。'}</p></div>
  </details>
}
export function Question({ question, answer, onError }: { question: ExtensionDialog; answer: (value: { value?: string; confirmed?: boolean; cancelled?: boolean }) => Promise<void>; onError: (text: string) => void }) {
  const [value, setValue] = useState(question.prefill || ''), [sending, setSending] = useState(false)
  const submit = async (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => { setSending(true); try { await answer(response) } catch (e) { onError(errorText(e)); setSending(false) } }
  return <section className="question-card" aria-label="Pi 的问题"><div className="eyebrow">需要你的回答</div><h3>{question.title}</h3>{question.message && <p>{question.message}</p>}
    {question.method === 'select' ? <div className="question-options">{question.options?.map((option, i) => <button disabled={sending} key={i} onClick={() => void submit({ value: option })}><span>{i + 1}</span>{option}<ChevronRight size={15} /></button>)}</div> : question.method !== 'confirm' && <textarea autoFocus value={value} rows={question.method === 'editor' ? 7 : 2} placeholder={question.placeholder || '输入你的回答…'} onChange={e => setValue(e.target.value)} />}
    <div className="question-actions"><button className="text-button" disabled={sending} onClick={() => void submit({ cancelled: true })}>取消</button>{question.method === 'confirm' ? <><button className="secondary-button" disabled={sending} onClick={() => void submit({ confirmed: false })}>否</button><button className="primary-button" disabled={sending} onClick={() => void submit({ confirmed: true })}>确认</button></> : question.method !== 'select' && <button className="primary-button" disabled={sending} onClick={() => void submit({ value })}>提交回答</button>}</div>
  </section>
}
export function FilePanel({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const [tab, setTab] = useState<'files' | 'diff'>('files'), [path, setPath] = useState(''), [items, setItems] = useState<FileItem[]>([])
  const [file, setFile] = useState(''), [content, setContent] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const generation = useRef(0)
  useEffect(() => {
    const id = ++generation.current; setLoading(true); setError(''); setContent(''); setFile('')
    const work = tab === 'diff' ? Promise.resolve() : window.desk.files(cwd, path).then(items => { if (id === generation.current) setItems(items) })
    void work.catch(e => { if (id === generation.current) setError(errorText(e)) }).finally(() => { if (id === generation.current) setLoading(false) })
    return () => { generation.current++ }
  }, [cwd, path, tab])
  async function open(item: FileItem) {
    if (item.directory) { setPath(item.path); return }
    const id = ++generation.current; setLoading(true); setError(''); setFile(item.path); setContent('')
    try { const text = await window.desk.readFile(cwd, item.path); if (id === generation.current) setContent(text) } catch (e) { if (id === generation.current) setError(errorText(e)) } finally { if (id === generation.current) setLoading(false) }
  }
  return <aside className="file-panel"><header><div className="panel-tabs"><button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>文件</button><button className={tab === 'diff' ? 'active' : ''} onClick={() => setTab('diff')}>修改差异</button></div><button className="icon-button" onClick={onClose} aria-label="关闭文件面板"><X size={17} /></button></header>
    {tab === 'diff' ? <ReviewPanel key={cwd} cwd={cwd} /> : <div className="file-breadcrumb"><button onClick={() => { setPath(''); setFile(''); setContent('') }}>{nameOf(cwd)}</button>{path && <><span>/</span><button onClick={() => { setPath(path.split('/').slice(0, -1).join('/')); setFile('') }}>{path}</button></>}</div>}
    {loading && <div className="panel-hint"><LoaderCircle className="spin" size={17} />正在读取…</div>}{error && <div className="panel-error">{error}</div>}
    {tab === 'files' && !file && !loading && <div className="file-list">{items.map(item => <button key={item.path} onClick={() => void open(item)}>{item.directory ? <Folder size={15} /> : <FileCode2 size={15} />}<span>{item.name}</span>{item.directory && <ChevronRight size={13} />}</button>)}{!items.length && <div className="panel-hint">这个文件夹是空的</div>}</div>}
    {file && <div className="file-title"><button className="text-button" onClick={() => { generation.current++; setFile(''); setContent(''); setLoading(false); setError('') }}>← 返回</button><span>{nameOf(file)}</span><CopyButton text={content} /></div>}
    {content && <pre className={`file-content ${tab === 'diff' ? 'diff-content' : ''}`}>{content.split('\n').map((line, i) => <div key={i} className={tab === 'diff' ? line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : line.startsWith('@@') ? 'hunk' : '' : ''}><span className="line-number">{i + 1}</span><span>{line || ' '}</span></div>)}</pre>}
    <footer>{tab === 'diff' ? '撤销文件改动与对话编辑相互独立' : '只读预览 · 文件保留在本机'}</footer>
  </aside>
}
