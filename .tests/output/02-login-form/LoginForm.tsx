import type React from 'react'
import { useId, useRef, useState } from 'react'
import type { LoginFormProps } from './types'

// ---------------------------------------------------------------------------
// Simple email regex — good enough for client-side UX validation
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface FieldErrors {
  email?: string
  password?: string
}

// ---------------------------------------------------------------------------
// LoginForm — a fully accessible, responsive login form with client-side
// validation, password visibility toggle, loading state, and error display.
// ---------------------------------------------------------------------------
export const LoginForm: React.FC<LoginFormProps> = ({
  onSubmit,
  isLoading = false,
  error = null,
}) => {
  // --- unique IDs for accessibility wiring --------------------------------
  const baseId = useId()
  const emailId = `${baseId}-email`
  const passwordId = `${baseId}-password`
  const emailErrorId = `${baseId}-email-error`
  const passwordErrorId = `${baseId}-password-error`
  const liveRegionId = `${baseId}-live`

  // --- form state ---------------------------------------------------------
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [touched, setTouched] = useState<Set<string>>(new Set())

  // ref to the first error field for focus management
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------
  const validate = (fields: { email?: string; password?: string }): FieldErrors => {
    const errs: FieldErrors = {}
    if (fields.email !== undefined) {
      if (!fields.email.trim()) {
        errs.email = 'Email is required'
      } else if (!EMAIL_RE.test(fields.email.trim())) {
        errs.email = 'Invalid email format'
      }
    }
    if (fields.password !== undefined) {
      if (!fields.password) {
        errs.password = 'Password is required'
      }
    }
    return errs
  }

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const allErrors = validate({ email: email.trim(), password })
    setErrors(allErrors)
    setTouched(new Set(['email', 'password']))

    if (Object.keys(allErrors).length === 0) {
      void onSubmit({ email: email.trim(), password, rememberMe })
    } else {
      // Focus the first field with an error
      if (allErrors.email) {
        emailRef.current?.focus()
      } else if (allErrors.password) {
        passwordRef.current?.focus()
      }
    }
  }

  const handleBlur = (field: 'email' | 'password') => {
    setTouched((prev) => new Set(prev).add(field))
    setErrors((prev) => ({
      ...prev,
      ...validate({ [field]: field === 'email' ? email.trim() : password }),
    }))
  }

  // Determine if we should show each error
  const showEmailError = touched.has('email') && errors.email
  const showPasswordError = touched.has('password') && errors.password
  const hasVisibleErrors = !!showEmailError || !!showPasswordError

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <div
      data-testid="login-card"
      className="mx-auto flex min-h-screen w-full max-w-md items-center justify-center px-4 sm:px-6"
    >
      <div className="w-full rounded-xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
        {/* Header */}
        <h1 className="mb-6 text-center text-2xl font-semibold text-gray-900">Sign In</h1>

        {/* External error banner */}
        {error && (
          <div
            role="alert"
            aria-live="polite"
            className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700"
          >
            {error}
          </div>
        )}

        {/* Live region for validation errors */}
        <div id={liveRegionId} role="alert" aria-live="assertive" className="sr-only">
          {hasVisibleErrors ? Object.values(errors).filter(Boolean).join('. ') : ''}
        </div>

        <form onSubmit={handleSubmit} noValidate>
          {/* ---- Email ---- */}
          <div className="mb-4">
            <label htmlFor={emailId} className="mb-1 block text-sm font-medium text-gray-700">
              Email
            </label>
            <input
              ref={emailRef}
              id={emailId}
              type="email"
              autoComplete="email"
              aria-label="Email address"
              aria-describedby={showEmailError ? emailErrorId : undefined}
              aria-invalid={showEmailError ? true : undefined}
              disabled={isLoading}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => handleBlur('email')}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500"
              placeholder="you@example.com"
            />
            {showEmailError && (
              <p id={emailErrorId} className="mt-1 text-xs text-red-600" role="alert">
                {errors.email}
              </p>
            )}
          </div>

          {/* ---- Password ---- */}
          <div className="mb-4">
            <label htmlFor={passwordId} className="mb-1 block text-sm font-medium text-gray-700">
              Password
            </label>
            <div className="relative">
              <input
                ref={passwordRef}
                id={passwordId}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                aria-label="Password"
                aria-describedby={showPasswordError ? passwordErrorId : undefined}
                aria-invalid={showPasswordError ? true : undefined}
                disabled={isLoading}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onBlur={() => handleBlur('password')}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 pr-10 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500"
                placeholder="Enter your password"
              />
              <button
                type="button"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-controls={passwordId}
                disabled={isLoading}
                onClick={() => setShowPassword((prev) => !prev)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-500 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:text-gray-400"
              >
                {showPassword ? (
                  /* Eye-off icon (simple SVG) */
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M13.875 18.825A10.05 10.05 0 0112 19c-5 0-9.27-3.11-11-7.5a11.93 11.93 0 013.375-4.875m2.25-1.95A9.98 9.98 0 0112 5c5 0 9.27 3.11 11 7.5a11.93 11.93 0 01-4.125 4.95M3 3l18 18"
                    />
                  </svg>
                ) : (
                  /* Eye icon */
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                    />
                  </svg>
                )}
              </button>
            </div>
            {showPasswordError && (
              <p id={passwordErrorId} className="mt-1 text-xs text-red-600" role="alert">
                {errors.password}
              </p>
            )}
          </div>

          {/* ---- Remember me & Forgot password ---- */}
          <div className="mb-6 flex items-center justify-between">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                aria-label="Remember me"
                checked={rememberMe}
                disabled={isLoading}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
              />
              Remember me
            </label>
            <a
              href="#"
              aria-label="Forgot password"
              className="text-sm text-blue-600 hover:text-blue-700 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-200"
              onClick={(e) => e.preventDefault()}
            >
              Forgot password?
            </a>
          </div>

          {/* ---- Submit ---- */}
          <button
            type="submit"
            disabled={isLoading}
            aria-label="Sign in"
            className="flex w-full items-center justify-center rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-blue-400"
          >
            {isLoading ? (
              <>
                {/* Simple spinner */}
                <svg
                  className="-ml-1 mr-2 h-4 w-4 animate-spin text-white"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                  />
                </svg>
                Signing in…
              </>
            ) : (
              'Sign In'
            )}
          </button>
        </form>

        {/* ---- Sign up link ---- */}
        <p className="mt-6 text-center text-sm text-gray-600">
          Don&apos;t have an account?{' '}
          <a
            href="#"
            aria-label="Sign up"
            className="font-medium text-blue-600 hover:text-blue-700 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-200"
            onClick={(e) => e.preventDefault()}
          >
            Sign up
          </a>
        </p>
      </div>
    </div>
  )
}
