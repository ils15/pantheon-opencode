export declare const MIN_SUPPORTED_PANTHEON_VERSION: '2.3.0'
export declare const MIN_SUPPORTED_HOST_VERSION: '2.0.0'
export declare const PANTHEON_PACKAGE_NAME: 'pantheon-opencode'

export interface PantheonInstallDetection {
  readonly ok: boolean
  readonly packageRoot: string | undefined
  readonly version: string | undefined
  readonly reasons: readonly string[]
}

export declare function isBelowSupportedPantheonVersion(
  version: unknown,
  minimumVersion?: string,
): boolean

export declare function inspectPantheonInstall(options?: {
  readonly packageRoot?: string
  readonly hostVersion?: string
}): PantheonInstallDetection

export declare function pantheonInstallGuardMessage(
  detection: PantheonInstallDetection,
  context?: { readonly hostVersion?: string },
): string

export declare function assertSupportedPantheonInstall(options?: {
  readonly packageRoot?: string
  readonly hostVersion?: string
}): PantheonInstallDetection
