export type JsonObject = Record<string, any>
export interface Installation { executable: string; node: string; version: string; compatible: boolean }
export interface Preferences {
  desktopNotifications: boolean;
  executable: string; node: string; agentDir: string; sessionDir: string;
  naming: { enabled: boolean; provider: string; modelId: string };
  projects: string[]; theme: 'light' | 'dark' | 'system'; archived: string[]; pinned: string[]
}
export interface SessionInfo {
  path: string; id: string; cwd: string; title: string; updatedAt: number; version: number; named?: boolean
}
export interface DisplayBlock {
  type: 'text' | 'thinking' | 'image' | 'toolCall'; text?: string;
  mimeType?: string; data?: string; id?: string; name?: string; arguments?: string
}
export interface DisplayMessage {
  editDiff?: EditDiff;
  id: string; entryId?: string; role: string; timestamp?: number; completedAt?: number; stopReason?: string; blocks: DisplayBlock[]; toolCallId?: string;
  toolName?: string; isError?: boolean; error?: string; streaming?: boolean
}
export interface ModelInfo {
  id: string; name: string; provider: string; reasoning: boolean; input: string[]; contextWindow: number
  thinkingLevelMap?: Partial<Record<string, string | null>>
}
export interface ExtensionDialog {
  id: string; method: 'select' | 'confirm' | 'input' | 'editor'; title: string;
  message?: string; options?: string[]; placeholder?: string; prefill?: string; expiresAt?: number
}
export interface EditDiff { text: string; format: 'unified' | 'pi'; truncated: boolean }
export interface ToolActivity { id: string; name: string; args: string; output: string; status: 'running' | 'done' | 'error'; editDiff?: EditDiff }
export interface RecoveryPreview { truncated?: boolean; message: DisplayMessage; savedAt: number }
export interface HistoryPage { messages: DisplayMessage[]; notice?: string; hasMore: boolean }
export interface RuntimeSnapshot {
  unread?: 'complete' | 'error' | 'question';
  lastEventAt?: number; phaseStartedAt?: number; retry?: { reason?: string; attempt?: number; max?: number; until?: number }; outcome?: 'complete' | 'error';
  settingsOnly?: boolean;
  prepared?: boolean;
  id: string; cwd: string; sessionPath?: string; title: string; completedRuns: number;
  phase: 'starting' | 'idle' | 'running' | 'waiting' | 'retrying' | 'compacting' | 'error' | 'closed';
  messages: DisplayMessage[]; tools: Record<string, ToolActivity>; model?: ModelInfo;
  models: ModelInfo[]; thinking: string; thinkingLevels: string[];
  settingsErrors?: { models?: string; thinking?: string };
  commands: { name: string; description: string; source: string }[];
  dialogs: ExtensionDialog[]; statuses: Record<string, string>; widgets: Record<string, string[]>;
  queue: { steering: string[]; followUp: string[] };
  notices: { id: string; text: string; level: string }[];
  stats?: { tokens: number; contextPercent?: number; contextTokens?: number; contextWindow?: number; cost?: number }; error?: string;
}
export interface NamingStatus { running: boolean; total: number; completed: number; failed: number; skipped: number; error?: string }
export interface ModelCatalog { models: ModelInfo[]; source: 'cache' | 'recent'; updatedAt?: number }
export type DefaultModel = Pick<ModelInfo, 'provider' | 'id' | 'name'>
export interface UpdateState {
  transferStage?: 'connecting' | 'receiving' | 'verifying'; receivedBytes?: number; totalBytes?: number; bytesPerSecond?: number;
  currentVersion: string; version?: string; notes?: string; progress?: number; error?: string;
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  supported: boolean;
}
export interface Bootstrap { version: string; defaultModel?: DefaultModel; namingStatus: NamingStatus; preferences: Preferences; installations: Installation[]; sessions: SessionInfo[]; runtimes: RuntimeSnapshot[]; warnings: string[] }
export type RuntimeAction =
  | { type: 'prompt'; message: string; behavior?: 'steer' | 'followUp'; images?: { type: 'image'; data: string; mimeType: string }[] }
  | { type: 'clearQueue' | 'stop' | 'refresh' | 'compact' | 'close' | 'activate' }
  | { type: 'model'; provider: string; modelId: string }
  | { type: 'thinking'; level: string }
  | { type: 'rename'; name: string }
  | { type: 'dialog'; id: string; value?: string; confirmed?: boolean; cancelled?: boolean }
export interface ProjectTrust { needsDecision: boolean; source: string }
export interface FileItem { name: string; path: string; directory: boolean }
export interface RevisionDraft { text: string; images: { type: 'image'; data: string; mimeType: string }[] }
export interface ReviewFile { id: string; path: string; patch: string; reversible: boolean; hunks: { id: string; header: string; patch: string }[] }
export interface ReviewSnapshot { id: string; sections: { staged: boolean; files: ReviewFile[] }[] }
export interface DeskAPI {
  fileReferences(cwd: string, query: string): Promise<{ paths: string[]; truncated: boolean }>
  recovery(path: string): Promise<RecoveryPreview | undefined>
  dismissRecovery(path: string): Promise<void>
  viewing(id: string | null): Promise<void>
  onNavigate(listener: (id: string) => void): () => void
  defaultModel(): Promise<DefaultModel | undefined>
  updateState(): Promise<UpdateState>
  checkUpdate(): Promise<UpdateState>
  downloadUpdate(): Promise<UpdateState>
  cancelUpdateDownload(): Promise<UpdateState>
  installUpdate(): Promise<void>
  onUpdate(listener: (state: UpdateState) => void): () => void
  revisionDraft(id: string, entryId: string): Promise<RevisionDraft>
  revise(id: string, entryId: string, mode: 'edit' | 'fork', input?: { message: string; images?: RevisionDraft['images'] }): Promise<{ snapshot: RuntimeSnapshot; applied: boolean; error?: string }>
  review(cwd: string): Promise<ReviewSnapshot>
  revert(cwd: string, snapshotId: string, staged: boolean, fileId?: string, hunkId?: string): Promise<ReviewSnapshot>
  bootstrap(): Promise<Bootstrap>
  namingModels(): Promise<{ provider: string; id: string }[]>
  nameSessions(): Promise<void>
  cancelNaming(): Promise<void>
  renameSession(path: string, title: string): Promise<void>
  onNaming(listener: (status: NamingStatus) => void): () => void
  selectPath(kind: 'project' | 'executable' | 'node' | 'agentDir' | 'sessionDir' | 'session'): Promise<string | null>
  savePreferences(patch: Partial<Preferences>): Promise<Preferences>
  projectTrust(cwd: string): Promise<ProjectTrust>
  history(path: string, before?: string): Promise<HistoryPage>
  prepareSettings(): Promise<string>
  modelCatalog(): Promise<ModelCatalog>
  start(options: { cwd: string; sessionPath?: string; trust?: boolean; prepared?: boolean }): Promise<string>
  action(id: string, action: RuntimeAction): Promise<void>
  pickImages(): Promise<{ type: 'image'; name: string; data: string; mimeType: string }[]>
  files(cwd: string, relative: string): Promise<FileItem[]>
  readFile(cwd: string, relative: string): Promise<string>
  diff(cwd: string): Promise<string>
  openExternal(url: string): Promise<void>
  copyText(text: string): Promise<void>
  onRuntime(listener: (snapshot: RuntimeSnapshot) => void): () => void
  onEditor(listener: (event: { id: string; text: string }) => void): () => void
}
