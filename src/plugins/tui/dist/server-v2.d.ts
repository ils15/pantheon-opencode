import { queryAlibabaTokenPlanUsage } from "./quota-cli.js";
import { Context } from "@opencode/plugin/promise/plugin";
//#region src/server-v2.d.ts
export declare function createQuotaPlugin(queryCli?: typeof queryAlibabaTokenPlanUsage): {
  id: string;
  setup(context: Context): Promise<() => Promise<void>>;
};
declare const _default: {
  id: string;
  setup(context: Context): Promise<() => Promise<void>>;
};
//#endregion
export { _default as default };
//# sourceMappingURL=server-v2.d.ts.map
