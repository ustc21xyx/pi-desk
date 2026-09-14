import { useEffect, useState } from 'react'
import { ChevronDown, LoaderCircle, RotateCcw, RefreshCw } from 'lucide-react'
import type { ReviewSnapshot } from '../../shared/contracts'
import { errorText, Modal } from './components'

export function ReviewPanel({ cwd }: { cwd: string }) {
  const [review, setReview] = useState<ReviewSnapshot>(), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [selection, setSelection] = useState<{ snapshotId: string; staged: boolean; fileId?: string; hunkId?: string; label: string }>()
  async function refresh() {
    setLoading(true); setError('')
    try { setReview(await window.desk.review(cwd)) } catch (e) { setError(errorText(e)); setReview(undefined) } finally { setLoading(false) }
  }
  useEffect(() => { let active = true; void window.desk.review(cwd).then(r => { if (active) setReview(r) }).catch(e => { if (active) setError(errorText(e)) }).finally(() => { if (active) setLoading(false) }); return () => { active = false } }, [cwd])
  async function revert() {
    if (!selection || working) return
    setWorking(true); setError('')
    try { setReview(await window.desk.revert(cwd, selection.snapshotId, selection.staged, selection.fileId, selection.hunkId)) }
    catch (e) { setError(errorText(e)); setReview(undefined) }
    finally { setWorking(false); setSelection(undefined) }
  }
  const lines = (patch: string) => <pre className="review-patch">{patch.split('\n').map((line, i) => <div key={i} className={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : line.startsWith('@@') ? 'hunk' : ''}>{line || ' '}</div>)}</pre>
  return <div className="review-panel">
    <div className="review-toolbar"><span>Git · 当前项目</span><button className="icon-button" title="刷新差异" aria-label="刷新差异" disabled={loading || working} onClick={() => void refresh()}><RefreshCw size={14} /></button></div>
    <p className="review-note">包含你的手动改动。未跟踪文件不在此列表中。</p>
    {loading && <div className="panel-hint"><LoaderCircle className="spin" size={15} />正在读取差异…</div>}
    {error && <div className="panel-error" role="alert">{error}<button className="text-button" onClick={() => void refresh()}>刷新</button></div>}
    {review?.sections.map(section => <section className="review-section" key={String(section.staged)}>
      <header><strong>{section.staged ? '已暂存' : '未暂存'} <span>{section.files.length}</span></strong><button className="text-button" disabled={loading || working || !section.files.length || section.files.some(f => !f.reversible)} onClick={() => setSelection({ snapshotId: review.id, staged: section.staged, label: `${section.files.length} 个文件的${section.staged ? '暂存' : '未暂存改动'}` })}>{section.staged ? '全部取消暂存' : '全部撤销'}</button></header>
      {!section.files.length && <p className="review-empty">没有{section.staged ? '已暂存' : '未暂存'}改动</p>}
      {section.files.map(file => <details className="review-file" key={file.id} open>
        <summary><ChevronDown size={13} /><span title={file.path}>{file.path}</span></summary>
        <div className="review-file-actions"><span>{!file.reversible ? '链接和子模块请在 Git 中处理' : ''}</span><button className="text-button" disabled={loading || working || !file.reversible} onClick={() => setSelection({ snapshotId: review.id, staged: section.staged, fileId: file.id, label: file.path })}><RotateCcw size={12} />{section.staged ? '取消暂存' : '撤销文件改动'}</button></div>
        {file.hunks.length ? file.hunks.map((hunk, i) => <div className="review-hunk" key={hunk.id}><div className="review-hunk-actions"><code>{hunk.header}</code><button className="text-button" disabled={loading || working} onClick={() => setSelection({ snapshotId: review.id, staged: section.staged, fileId: file.id, hunkId: hunk.id, label: `${file.path} · 代码块 ${i + 1}` })}>{section.staged ? '取消暂存此块' : '撤销此块'}</button></div>{lines(hunk.patch.split('\n').slice(1).join('\n'))}</div>) : lines(file.patch)}
      </details>)}
    </section>)}
    {selection && <Modal title={selection.staged ? '取消暂存？' : '撤销这些文件改动？'} onClose={() => { if (!working) setSelection(undefined) }}><div className="modal-body"><p>{selection.label}</p><p>{selection.staged ? '只从暂存区移出所选改动，文件内容会保留。' : '将所选未暂存改动恢复到暂存区版本，其中可能包含你的手动修改。对话记录保持不变。'}</p>{error && <p role="alert">{error}</p>}</div><footer className="modal-footer"><button className="text-button" disabled={working} onClick={() => setSelection(undefined)}>取消</button><button className="primary-button" disabled={working} onClick={() => void revert()}>{working ? '正在处理…' : selection.staged ? '确认取消暂存' : '确认撤销'}</button></footer></Modal>}
  </div>
}
