export { createApi, pushWithBase } from './api.ts'
export type { Api, ApiOptions, AssetDownload, ContentResult, ContentView, FolderMeta, PushOutcome, PushWithBaseOptions, VaultMeta } from './api.ts'
export {
  DEFAULT_SERVER_URL,
  DEVICE_CLIENT_ID,
  clearCredentials,
  configDir,
  configPath,
  loginWithDeviceCode,
  resolveConfig,
  writeConfig,
} from './config.ts'
export type { CliConfig, DeviceLoginIO } from './config.ts'
export {
  assetStatePath,
  assetContentType,
  decideAssetSync,
  docAssetOps,
  folderAssetOps,
  imageContentType,
  md5Hex,
  pullAssets,
  readAssetState,
  scanLocalAssets,
  syncAssets,
  writeAssetState,
} from './assets.ts'
export type {
  AssetDecision,
  AssetOps,
  AssetState,
  AssetStateFile,
  AssetSyncAction,
  AssetSyncResult,
  LocalAsset,
  PullAssetsOptions,
  SyncAssetsOptions,
} from './assets.ts'
export { parseDocRef, parseShareToken } from './docref.ts'
export { CliError, DEGENERATE_MESSAGE } from './errors.ts'
export {
  allocateDirName,
  clone,
  filenameForLocalFile,
  folderChildren,
  isWorkspace,
  readWorkspaceConfig,
  syncWorkspace,
  warnLikelyLocalRename,
  workspaceConfigPath,
  writeWorkspaceConfig,
} from './mirror.ts'
export type { CloneOptions, CloneResult, MirrorSyncOptions, MirrorSyncOutcome, WorkspaceConfig } from './mirror.ts'
export { createProgram, runCli } from './program.ts'
export type { ProgramDeps } from './program.ts'
export {
  fileForDoc,
  folderConfigPath,
  pullFolder,
  pushAll,
  pushRejection,
  readFolderConfig,
  resolveFolder,
  resolveVault,
  syncAll,
  syncExitCode,
  syncTracked,
  writeFolderConfig,
} from './sync.ts'
export type {
  FolderConfig,
  PullFolderOptions,
  PullFolderResult,
  PushAllOptions,
  SyncAction,
  SyncDocResult,
  SyncOptions,
} from './sync.ts'
export {
  WORKSPACE_DIR,
  WORKSPACE_DIR_LEGACY,
  docStateDir,
  findWorkspace,
  listMetas,
  loadWorkspace,
  recordBase,
  rewriteMeta,
  sha256Hex,
  slugify,
  workspaceRoot,
  writePull,
} from './workspace.ts'
export type { DocWorkspaceMeta, RecordBaseOptions, Workspace, WritePullOptions } from './workspace.ts'
