import os from 'node:os'
import path from 'node:path'

/** Resolve the global OpenCode config directory used by init and setup. */
export function resolveGlobalConfigDirectory(env = process.env, home = os.homedir()) {
  const xdgConfigHome = env.XDG_CONFIG_HOME
  if (
    xdgConfigHome !== undefined &&
    xdgConfigHome !== '' &&
    (typeof xdgConfigHome !== 'string' || !path.isAbsolute(xdgConfigHome))
  ) {
    throw new Error('XDG_CONFIG_HOME must be an absolute path.')
  }
  return path.join(xdgConfigHome || path.join(home, '.config'), 'opencode')
}
