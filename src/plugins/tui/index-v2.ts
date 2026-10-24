// The V2 plugin loader uses this server-side entrypoint. Keep it separate from
// the V1-compatible `./server` package export.
export { default } from './dist/server-v2.js'
