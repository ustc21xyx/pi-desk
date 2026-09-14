import { useEffect, useState } from 'react'
import { Download, LoaderCircle, RefreshCw } from 'lucide-react'
import type { UpdateState } from '../../shared/contracts'
import { errorText } from './components'

export function UpdateSection({ settingsDirty }: { settingsDirty: boolean }) {
  const [state, setState] = useState<UpdateState>()
  const [error, setError] = useState('')
  const [requesting, setRequesting] = useState(false)
  useEffect(() => {
    let active = true, received = false
    const off = window.desk.onUpdate(value => { received = true; if (active) setState(value) })
    void window.desk.updateState().then(value => { if (active && !received) setState(value) }).catch(e => { if (active) setError(errorText(e)) })
    return () => { active = false; off() }
  }, [])
  async function perform(action: 'check' | 'download' | 'install') {
    setRequesting(true); setError('')
    try {
      if (action === 'install') await window.desk.installUpdate()
      else setState(await (action === 'check' ? window.desk.checkUpdate() : window.desk.downloadUpdate()))
    } catch (e) { setError(errorText(e)) } finally { setRequesting(false) }
  }
  const busy = requesting || ['checking', 'downloading', 'installing'].includes(state?.phase || '')
  const title = !state ? '正在读取版本…' : state.phase === 'current' ? '已是最新版本' : state.phase === 'checking' ? '正在检查更新…' : state.phase === 'downloading' ? `正在下载 · ${state.progress || 0}%` : state.phase === 'installing' ? '正在准备重启安装…' : state.phase === 'ready' ? `${state.version} 已下载` : state.version ? `发现新版本 ${state.version}` : `当前版本 ${state.currentVersion}`
  return <section className="setting-section update-section">
    <h4>应用更新</h4>
    <div className="update-row"><span role="status">{title}</span><button className="secondary-button" disabled={!state || busy} onClick={() => void perform('check')}>{state?.phase === 'checking' ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}检查更新</button></div>
    {state?.phase === 'downloading' && <progress aria-label="更新下载进度" max={100} value={state.progress || 0} />}
    <p className="setting-description">从 GitHub 下载更新，保留配置和会话。任务结束后可重启安装。</p>
    {state && !state.supported && <p className="setting-description">请在已安装的 macOS 应用中下载并安装更新。</p>}
    {state?.notes && <details className="update-notes"><summary>版本说明</summary><p>{state.notes}</p></details>}
    {(error || state?.error) && <p className="update-error" role="alert">{error || state?.error}</p>}
    {state?.version && state.supported && <div className="update-actions">
      {state.phase === 'ready' ? <button className="primary-button" disabled={busy || settingsDirty} onClick={() => void perform('install')}>重启并安装</button> : <button className="primary-button" disabled={busy} onClick={() => void perform('download')}><Download size={14} />{state.phase === 'downloading' ? '正在下载…' : '下载更新'}</button>}
      {state.phase === 'ready' && settingsDirty && <small>请先保存本页设置。</small>}
    </div>}
  </section>
}
