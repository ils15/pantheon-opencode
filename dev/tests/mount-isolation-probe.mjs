import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'

const sentinelPath = process.env.PICKLEBALL_OUTSIDE_SENTINEL
const socketPath = process.env.PICKLEBALL_OUTSIDE_SOCKET
assert.ok(sentinelPath && socketPath, 'outside-allowlist canaries are required')

assert.throws(
  () => readFileSync(sentinelPath, 'utf8'),
  (error) => error.code === 'ENOENT' || error.code === 'ENOTDIR',
  'host sentinel file must not be visible inside the sandbox',
)

await new Promise((resolve, reject) => {
  const socket = createConnection(socketPath)
  socket.once('connect', () => {
    socket.destroy()
    reject(new Error('host Unix socket canary was reachable inside the sandbox'))
  })
  socket.once('error', (error) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') resolve()
    else reject(error)
  })
})

process.stdout.write('Mount isolation verified: sentinel=hidden unixSocket=hidden\n')
