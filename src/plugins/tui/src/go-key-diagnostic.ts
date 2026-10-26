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
    try {
      const response = await fetch('https://opencode.ai/zen/go/v1/usage', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          'x-opencode-session': 'pantheon-quota',
          'user-agent': 'Pantheon-Quota/1.0',
        },
        redirect: 'manual',
        signal: AbortSignal.any([signal, timeout]),
      })
      const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      const contentType = !mediaType
        ? 'missing'
        : mediaType === 'application/json' ||
            mediaType === 'text/plain' ||
            mediaType === 'text/html'
          ? mediaType
          : 'other'
      // Parsing budget is zero bytes: no body/error code is needed to classify a 401.
      // Cancel without awaiting an untrusted stream and never inspect Location.
      void response.body?.cancel().catch(() => {})
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
      }
    } catch {
      // Fetch errors can include headers, URLs, or provider body text. Never forward/log them.
      return { category: timeout.aborted ? 'timeout' : 'network_error' }
    }
  }
}
