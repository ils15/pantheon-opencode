/** Deliberately excludes response bodies, provider messages, and credential data. */
export type GoKeyDiagnosticResult = {
  category:
    | 'not_run'
    | 'already_used'
    | 'success'
    | 'unauthorized'
    | 'redirect'
    | 'http_error'
    | 'timeout'
    | 'network_error'
  status?: number
  content_type?: 'application/json' | 'text/plain' | 'text/html' | 'other' | 'missing'
  error_structure?: 'present' | 'absent' | 'unavailable'
}

/** Parse at most 4 KiB; inspect only own top-level error presence, never its value. */
async function errorStructure(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<NonNullable<GoKeyDiagnosticResult['error_structure']>> {
  if (!body) return 'unavailable'
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let abort: () => void = () => {}
  let complete = false
  try {
    reader = body.getReader()
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('aborted'))
      signal.addEventListener('abort', abort, { once: true })
    })
    const bytes = new Uint8Array(4096)
    let length = 0
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) {
        complete = true
        break
      }
      if (value.byteLength > bytes.length - length) return 'unavailable'
      bytes.set(value, length)
      length += value.byteLength
    }
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)),
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unavailable'
    return Object.hasOwn(parsed, 'error') ? 'present' : 'absent'
  } catch {
    // Untrusted parse/stream errors may contain body text; never forward or log them.
    return 'unavailable'
  } finally {
    signal.removeEventListener('abort', abort)
    if (!complete) void (reader ? reader.cancel() : body.cancel()).catch(() => {})
    reader?.releaseLock()
  }
}

/** One explicit invocation per plugin runtime, including failed/no-credential attempts. */
export function createGoKeyDiagnostic() {
  let attempted = false
  return async (
    resolveKey: () => Promise<string | undefined>,
    signal: AbortSignal,
  ): Promise<GoKeyDiagnosticResult> => {
    if (attempted) return { category: 'already_used' }
    // Claim synchronously, before credential resolution or any other await.
    attempted = true
    let key: string | undefined
    try {
      key = await resolveKey()
    } catch {
      return { category: 'not_run' }
    }
    if (!key || signal.aborted) return { category: 'not_run' }

    const timeout = AbortSignal.timeout(5_000)
    const requestSignal = AbortSignal.any([signal, timeout])
    try {
      const response = await fetch('https://opencode.ai/zen/go/v1/usage', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          'x-opencode-session': 'pantheon-quota',
          'user-agent': 'Pantheon-Quota/1.0',
        },
        redirect: 'manual',
        signal: requestSignal,
      })
      const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      const contentType = !mediaType
        ? 'missing'
        : mediaType === 'application/json' ||
            mediaType === 'text/plain' ||
            mediaType === 'text/html'
          ? mediaType
          : 'other'
      let structure: GoKeyDiagnosticResult['error_structure']
      if (response.status === 401 && contentType === 'application/json') {
        structure = await errorStructure(response.body, requestSignal)
      } else {
        // Cancel without reading and never inspect Location.
        void response.body?.cancel().catch(() => {})
        if (response.status === 401) structure = 'unavailable'
      }
      return {
        category:
          response.status === 401
            ? 'unauthorized'
            : response.status >= 300 && response.status < 400
              ? 'redirect'
              : response.ok
                ? 'success'
                : 'http_error',
        status: response.status,
        content_type: contentType,
        ...(structure ? { error_structure: structure } : {}),
      }
    } catch {
      // Fetch errors can include headers, URLs, or provider body text. Never forward/log them.
      return { category: timeout.aborted ? 'timeout' : 'network_error' }
    }
  }
}
