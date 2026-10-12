declare module '@opencode/plugin/tui' {
  export const Plugin: {
    define<T>(plugin: T): T
  }
}

declare module '@opencode/plugin' {
  export const Plugin: {
    define<T>(plugin: T): T
  }
}

declare const __PANTHEON_VERSION__: string
