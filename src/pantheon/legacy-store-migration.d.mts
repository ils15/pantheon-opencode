export interface MigrationReport {
  readonly memoriesMigrated: number
  readonly memoriesExpiredPurged: number
  readonly vectorTablesDropped: number
  readonly contextsMigrated: number
  readonly goalsMigrated: number
  readonly staleFilesDeleted: string[]
}

export interface MigrateLegacyStoresOptions {
  readonly globalConfigDir?: string
  readonly dryRun?: boolean
}

export function resolveSafeGlobalConfigDir(env?: NodeJS.ProcessEnv): string | undefined

export function resetLegacyMigrationCacheForTests(): void

export function ensureLegacyStoresMigratedOnce(
  workspaceDir: string,
  options?: MigrateLegacyStoresOptions,
): MigrationReport | null

export function migrateLegacyStoresAndPurgeStale(
  workspaceDir: string,
  options?: MigrateLegacyStoresOptions,
): MigrationReport

export type LegacyArtifactScope = 'global' | 'project'
export type LegacyArtifactCategory =
  | 'legacyStore'
  | 'hooks'
  | 'v1Obsolete'
  | 'backup'
  | 'redundantAsset'
  | 'drift'

export interface LegacyArtifactItem {
  readonly path: string
  readonly scope: LegacyArtifactScope
  readonly category: LegacyArtifactCategory
  readonly reason: string
  readonly bytes: number
}

export interface LegacyScanResult {
  readonly items: LegacyArtifactItem[]
  readonly summary: {
    readonly total: number
    readonly totalBytes: number
    readonly unmigratedStores: number
    readonly byScope: Record<LegacyArtifactScope, number>
    readonly byCategory: Record<string, number>
  }
}

export interface ScanLegacyArtifactsOptions {
  readonly workspaceDir?: string
  readonly globalConfigDir?: string
  readonly runningVersion?: string
  readonly includeRedundantCopiedAssets?: boolean
}

export interface CleanLegacyArtifactsOptions extends ScanLegacyArtifactsOptions {
  readonly scope?: 'all' | LegacyArtifactScope
  readonly categories?: readonly LegacyArtifactCategory[]
}

export interface CleanLegacyArtifactsResult {
  readonly removed: string[]
  readonly reclaimedBytes: number
  readonly errors: Array<{ readonly path: string; readonly reason: string }>
  readonly migrated: MigrationReport | null
}

export function scanLegacyArtifacts(options?: ScanLegacyArtifactsOptions): LegacyScanResult

export function cleanLegacyArtifacts(
  options?: CleanLegacyArtifactsOptions,
): CleanLegacyArtifactsResult
