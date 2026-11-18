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

export function resetLegacyMigrationCacheForTests(): void

export function ensureLegacyStoresMigratedOnce(
  workspaceDir: string,
  options?: MigrateLegacyStoresOptions,
): MigrationReport | null

export function migrateLegacyStoresAndPurgeStale(
  workspaceDir: string,
  options?: MigrateLegacyStoresOptions,
): MigrationReport
