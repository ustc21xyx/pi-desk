import { contextBridge, ipcRenderer } from 'electron'
import type { DeskAPI } from '../shared/contracts'
const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`desk:${name}`, ...args)
const api: DeskAPI = {
  revisionDraft: (id, entryId) => invoke('revisionDraft', id, entryId),
  revise: (id, entryId, mode, input) => invoke('revise', id, entryId, mode, input),
  review: cwd => invoke('review', cwd), revert: (cwd, snapshotId, staged, fileId, hunkId) => invoke('revert', cwd, snapshotId, staged, fileId, hunkId),
  namingModels: () => invoke('namingModels'), nameSessions: () => invoke('nameSessions'), cancelNaming: () => invoke('cancelNaming'), renameSession: (path, title) => invoke('renameSession', path, title),
  onNaming: listener => { const fn = (_event: unknown, status: any) => listener(status); ipcRenderer.on('desk:naming', fn); return () => ipcRenderer.removeListener('desk:naming', fn) },
  bootstrap: () => invoke('bootstrap'), selectPath: kind => invoke('selectPath', kind),
  savePreferences: patch => invoke('savePreferences', patch), projectTrust: cwd => invoke('projectTrust', cwd),
  history: path => invoke('history', path), prepareSettings: () => invoke('prepareSettings'), modelCatalog: () => invoke('modelCatalog'), start: options => invoke('start', options),
  action: (id, action) => invoke('action', id, action), pickImages: () => invoke('pickImages'),
  files: (cwd, path) => invoke('files', cwd, path), readFile: (cwd, path) => invoke('readFile', cwd, path),
  diff: cwd => invoke('diff', cwd), copyText: text => invoke('copyText', text), openExternal: url => invoke('openExternal', url),
  onRuntime: listener => { const fn = (_event: unknown, snapshot: any) => listener(snapshot); ipcRenderer.on('desk:runtime', fn); return () => ipcRenderer.removeListener('desk:runtime', fn) },
  onEditor: listener => { const fn = (_event: unknown, value: any) => listener(value); ipcRenderer.on('desk:editor', fn); return () => ipcRenderer.removeListener('desk:editor', fn) }
}
contextBridge.exposeInMainWorld('desk', api)
