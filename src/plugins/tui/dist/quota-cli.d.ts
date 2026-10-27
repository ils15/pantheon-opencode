import { spawn } from "node:child_process";
//#region src/quota-cli.d.ts
export type AlibabaTokenPlanUsageResult = {
  readonly percentage: number;
} | {
  readonly reason: 'cli_identity_unavailable' | 'provider_error';
};
/** Parse only the documented Bailian CLI JSON fields for Personal Token Plan. */
export declare function parseAlibabaTokenPlanPercentage(output: string): number | undefined;
/**
 * Run the fixed Bailian command only through an explicitly trusted absolute
 * executable path. Credentials remain in the CLI's own login store; Pantheon
 * passes no provider secrets or arbitrary arguments.
 */
export declare function queryAlibabaTokenPlanUsage(signal: AbortSignal, spawnProcess?: typeof spawn, environment?: NodeJS.ProcessEnv): Promise<AlibabaTokenPlanUsageResult>;
//#endregion
//# sourceMappingURL=quota-cli.d.ts.map
