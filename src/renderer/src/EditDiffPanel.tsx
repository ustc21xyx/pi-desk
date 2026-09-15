import { useMemo, useState } from 'react'
import { FileCode2, X } from 'lucide-react'
import type { EditDiff } from '../../shared/contracts'
import { clean, nameOf } from './components'

type Line = { kind: 'added' | 'removed' | 'context' | 'meta'; text: string; old?: number; next?: number }

function parseDiff(diff: EditDiff): Line[] {
  let old = 0, next = 0, inHunk = false
  return clean(diff.text).split('\n').flatMap((text, index, source): Line[] => {
    if (!text && index === source.length - 1) return []
    if (diff.format === 'pi') {
      const match = /^([+ -])\s*(\d+) (.*)$/.exec(text)
      if (!match) return [{ kind: 'meta', text }]
      const number = Number(match[2])
      // Pi's compact format records new line numbers for context, old for deletions.
      return [{ kind: match[1] === '+' ? 'added' : match[1] === '-' ? 'removed' : 'context', text: match[3], old: match[1] === '-' ? number : undefined, next: match[1] !== '-' ? number : undefined }]
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true; return [{ kind: 'meta', text }] }
    if (inHunk && text.startsWith('+')) return [{ kind: 'added', text: text.slice(1), next: next++ }]
    if (inHunk && text.startsWith('-')) return [{ kind: 'removed', text: text.slice(1), old: old++ }]
    if (inHunk && text.startsWith(' ')) return [{ kind: 'context', text: text.slice(1), old: old++, next: next++ }]
    return [{ kind: 'meta', text }]
  })
}

function pairLines(lines: Line[]) {
  const rows: { left?: Line; right?: Line; meta?: string }[] = []
  let removed: Line[] = [], added: Line[] = []
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push({ left: removed[i], right: added[i] })
    removed = []; added = []
  }
  for (const line of lines) {
    if (line.kind === 'removed') removed.push(line)
    else if (line.kind === 'added') added.push(line)
    else { flush(); rows.push(line.kind === 'meta' ? { meta: line.text } : { left: line, right: line }) }
  }
  flush()
  return rows
}

export function EditDiffPanel({ path, diff, onClose, onFiles }: { path: string; diff: EditDiff; onClose: () => void; onFiles?: () => void }) {
  const [split, setSplit] = useState(false)
  const lines = useMemo(() => parseDiff(diff), [diff])
  const pairs = useMemo(() => pairLines(lines), [lines])
  const cell = (line: Line | undefined, side: 'old' | 'next') => <div className={`edit-diff-cell ${line?.kind || 'empty'}`}><span className="diff-number">{line?.[side]}</span><span className="diff-sign">{line?.kind === 'added' ? '+' : line?.kind === 'removed' ? '−' : ''}</span><code>{line?.text || ' '}</code></div>
  return <aside className="file-panel edit-diff-panel" aria-label="本次编辑差异">
    <header><strong><FileCode2 size={15} />本次编辑</strong><div>{onFiles && <button className="text-button" onClick={onFiles}>文件与修改</button>}<button className="icon-button" onClick={onClose} aria-label="关闭编辑差异"><X size={17} /></button></div></header>
    <div className="edit-diff-heading"><strong title={path}>{nameOf(path) || '本次编辑'}</strong><code>{path}</code><div className="edit-diff-toolbar"><div className="edit-diff-legend" aria-label="预览增删行数"><span className="diff-added">+{lines.filter(line => line.kind === 'added').length}</span><span className="diff-removed">−{lines.filter(line => line.kind === 'removed').length}</span>{diff.truncated && <span>部分预览</span>}</div><div className="diff-view-toggle" aria-label="差异显示方式"><button aria-pressed={!split} onClick={() => setSplit(false)}>行内</button><button aria-pressed={split} onClick={() => setSplit(true)}>并排</button></div></div></div>
    <div className="edit-diff-scroll" tabIndex={0} aria-label="编辑内容差异">
      {split ? <div className="edit-diff-split"><div className="diff-column-titles"><span>修改前</span><span>修改后</span></div>{pairs.map((row, index) => row.meta !== undefined ? <div className="diff-meta" key={index}>{row.meta}</div> : <div className="edit-diff-pair" key={index}>{cell(row.left, 'old')}{cell(row.right, 'next')}</div>)}</div> : <div className="edit-diff-unified"><div className="diff-column-titles"><span>行号：修改前 → 修改后</span></div>{lines.map((line, index) => line.kind === 'meta' ? <div className="diff-meta" key={index}>{line.text}</div> : <div className={`edit-diff-row ${line.kind}`} key={index}><span className="diff-number">{line.old}</span><span className="diff-number">{line.next}</span><span className="diff-sign">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}</span><code>{line.text || ' '}</code></div>)}</div>}
    </div>
    <footer>{diff.truncated ? '差异较长，仅预览前 1,500 行或 150,000 字符；完整记录保留在本机 Pi 会话中。' : '仅此一次编辑 · 来自会话保存的修改记录'}</footer>
  </aside>
}
