import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { LoginForm } from './LoginForm'

// ---------------------------------------------------------------------------
// Helper: render the form with optional overrides
// ---------------------------------------------------------------------------
function setup(overrides: Partial<Parameters<typeof LoginForm>[0]> = {}) {
  const onSubmit = vi.fn()
  const utils = render(
    <LoginForm onSubmit={onSubmit} isLoading={false} error={null} {...overrides} />,
  )
  const user = userEvent.setup()
  return { onSubmit, user, ...utils }
}

// ---------------------------------------------------------------------------
// Accessibility helpers
// ---------------------------------------------------------------------------
function getEmailInput(): HTMLInputElement {
  return screen.getByLabelText(/email/i) as HTMLInputElement
}
function getPasswordInput(): HTMLInputElement {
  // The password <input> has aria-label="Password" (exact), while the toggle
  // button has "Show password" / "Hide password" — exact match avoids collisions.
  return screen.getByLabelText('Password') as HTMLInputElement
}
function getRememberMe(): HTMLInputElement {
  return screen.getByLabelText(/remember me/i) as HTMLInputElement
}
function getSubmitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /sign in/i })
}

describe('LoginForm', () => {
  // -----------------------------------------------------------------------
  // 1. Renders all fields
  // -----------------------------------------------------------------------
  describe('renders all fields', () => {
    it('renders an email input', () => {
      setup()
      expect(getEmailInput()).toBeInTheDocument()
    })

    it('renders a password input', () => {
      setup()
      expect(getPasswordInput()).toBeInTheDocument()
    })

    it('renders a "Remember me" checkbox', () => {
      setup()
      expect(getRememberMe()).toBeInTheDocument()
    })

    it('renders a submit button with "Sign In" text', () => {
      setup()
      const btn = getSubmitButton()
      expect(btn).toBeInTheDocument()
      expect(btn).toHaveTextContent(/sign in/i)
    })

    it('renders "Forgot password?" link', () => {
      setup()
      expect(screen.getByRole('link', { name: /forgot password/i })).toBeInTheDocument()
    })

    it('renders "Sign up" link', () => {
      setup()
      expect(screen.getByRole('link', { name: /sign up/i })).toBeInTheDocument()
    })

    it('has password input type set to "password" by default', () => {
      setup()
      expect(getPasswordInput()).toHaveAttribute('type', 'password')
    })
  })

  // -----------------------------------------------------------------------
  // 2. Shows validation errors on empty submit
  // -----------------------------------------------------------------------
  describe('validation', () => {
    it('shows "Email is required" when email is empty on submit', async () => {
      const { user } = setup()
      await user.click(getSubmitButton())
      // Use exact match — the sr-only region concatenates errors with ". ",
      // so only the <p> element contains the exact text.
      expect(screen.getByText(/^Email is required$/)).toBeInTheDocument()
    })

    it('shows "Password is required" when password is empty on submit', async () => {
      const { user } = setup()
      await user.click(getSubmitButton())
      expect(screen.getByText(/^Password is required$/)).toBeInTheDocument()
    })

    it('shows "Invalid email format" for an invalid email', async () => {
      const { user } = setup()
      await user.type(getEmailInput(), 'not-an-email')
      await user.click(getSubmitButton())
      expect(screen.getByText(/^Invalid email format$/)).toBeInTheDocument()
    })

    it('removes validation errors after correcting fields', async () => {
      const { user } = setup()
      await user.click(getSubmitButton())
      expect(screen.getByText(/^Email is required$/)).toBeInTheDocument()

      await user.type(getEmailInput(), 'test@example.com')
      await user.click(getSubmitButton())
      // Email error should be gone, password error still there
      expect(screen.queryByText(/^Email is required$/)).not.toBeInTheDocument()
      expect(screen.queryByText(/^Invalid email format$/)).not.toBeInTheDocument()
    })

    it('announces validation errors to screen readers via aria-live', async () => {
      const { user } = setup()
      await user.click(getSubmitButton())

      // The sr-only live region is the <div> with role="alert" and aria-live="assertive"
      const alerts = screen.getAllByRole('alert')
      const liveRegion = alerts.find((el) => el.getAttribute('aria-live') === 'assertive')
      expect(liveRegion).toBeInTheDocument()
      expect(liveRegion).toHaveTextContent(/email is required/i)
    })
  })

  // -----------------------------------------------------------------------
  // 3. Toggles password visibility
  // -----------------------------------------------------------------------
  describe('password visibility toggle', () => {
    it('shows a toggle button to show/hide password', () => {
      setup()
      expect(screen.getByRole('button', { name: /show password/i })).toBeInTheDocument()
    })

    it('changes password input type to text when "Show" is clicked', async () => {
      const { user } = setup()
      const toggle = screen.getByRole('button', { name: /show password/i })
      await user.click(toggle)
      expect(getPasswordInput()).toHaveAttribute('type', 'text')
    })

    it('changes toggle label to "Hide password" when password is visible', async () => {
      const { user } = setup()
      const toggle = screen.getByRole('button', { name: /show password/i })
      await user.click(toggle)
      expect(screen.getByRole('button', { name: /hide password/i })).toBeInTheDocument()
    })

    it('toggles back to password type when clicked twice', async () => {
      const { user } = setup()
      const toggle = screen.getByRole('button', { name: /show password/i })
      await user.click(toggle)
      await user.click(toggle)
      expect(getPasswordInput()).toHaveAttribute('type', 'password')
    })
  })

  // -----------------------------------------------------------------------
  // 4. Calls onSubmit with email/password
  // -----------------------------------------------------------------------
  describe('submission', () => {
    it('calls onSubmit with email, password, and rememberMe on valid submit', async () => {
      const { user, onSubmit } = setup()
      await user.type(getEmailInput(), 'user@example.com')
      await user.type(getPasswordInput(), 'secret123')
      await user.click(getSubmitButton())

      expect(onSubmit).toHaveBeenCalledTimes(1)
      expect(onSubmit).toHaveBeenCalledWith({
        email: 'user@example.com',
        password: 'secret123',
        rememberMe: false,
      })
    })

    it('passes rememberMe as true when checkbox is checked', async () => {
      const { user, onSubmit } = setup()
      await user.type(getEmailInput(), 'user@example.com')
      await user.type(getPasswordInput(), 'secret123')
      await user.click(getRememberMe())
      await user.click(getSubmitButton())

      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ rememberMe: true }))
    })

    it('does not call onSubmit when validation fails', async () => {
      const { user, onSubmit } = setup()
      await user.click(getSubmitButton())
      expect(onSubmit).not.toHaveBeenCalled()
    })

    it('preserves input values across re-renders with same props', async () => {
      const { user, rerender } = setup()
      await user.type(getEmailInput(), 'persist@example.com')
      await user.type(getPasswordInput(), 'keepit')
      rerender(<LoginForm onSubmit={vi.fn()} />)
      expect(getEmailInput()).toHaveValue('persist@example.com')
      expect(getPasswordInput()).toHaveValue('keepit')
    })
  })

  // -----------------------------------------------------------------------
  // 5. Disables button during loading
  // -----------------------------------------------------------------------
  describe('loading state', () => {
    it('disables the submit button when isLoading is true', () => {
      setup({ isLoading: true })
      expect(getSubmitButton()).toBeDisabled()
    })

    it('shows a loading indicator on the button when isLoading is true', () => {
      setup({ isLoading: true })
      expect(screen.getByText(/signing in/i)).toBeInTheDocument()
    })

    it('disables inputs when isLoading is true', () => {
      setup({ isLoading: true })
      expect(getEmailInput()).toBeDisabled()
      expect(getPasswordInput()).toBeDisabled()
      expect(getRememberMe()).toBeDisabled()
    })

    it('re-enables button when loading finishes', () => {
      const { rerender } = setup({ isLoading: true })
      rerender(<LoginForm onSubmit={vi.fn()} isLoading={false} />)
      expect(getSubmitButton()).not.toBeDisabled()
    })
  })

  // -----------------------------------------------------------------------
  // 6. Displays external error
  // -----------------------------------------------------------------------
  describe('error display', () => {
    it('renders an external error message when error prop is set', () => {
      setup({ error: 'Invalid credentials' })
      // The error banner is a <div role="alert" aria-live="polite"> — distinct from
      // the sr-only live region (aria-live="assertive").
      const alerts = screen.getAllByRole('alert')
      const errorBanner = alerts.find((el) => el.getAttribute('aria-live') === 'polite')
      expect(errorBanner).toBeInTheDocument()
      expect(errorBanner).toHaveTextContent(/invalid credentials/i)
    })

    it('does not render error banner when error is null', () => {
      setup({ error: null })
      const alerts = screen.getAllByRole('alert')
      const errorBanner = alerts.find((el) => el.getAttribute('aria-live') === 'polite')
      expect(errorBanner).toBeUndefined()
    })

    it('renders error in an aria-live region', () => {
      setup({ error: 'Something went wrong' })
      const alerts = screen.getAllByRole('alert')
      const errorBanner = alerts.find((el) => el.getAttribute('aria-live') === 'polite')
      expect(errorBanner).toBeInTheDocument()
      expect(errorBanner).toHaveTextContent(/something went wrong/i)
    })
  })

  // -----------------------------------------------------------------------
  // 7. Keyboard navigation and focus
  // -----------------------------------------------------------------------
  describe('keyboard navigation', () => {
    it('allows tabbing through all form controls', async () => {
      const { user } = setup()
      const toggle = screen.getByRole('button', { name: /show password/i })
      const forgotLink = screen.getByRole('link', { name: /forgot password/i })
      const signUpLink = screen.getByRole('link', { name: /sign up/i })

      await user.tab()
      expect(getEmailInput()).toHaveFocus()

      await user.tab()
      expect(getPasswordInput()).toHaveFocus()

      // Password visibility toggle sits between the password input and
      // "Remember me" in DOM order
      await user.tab()
      expect(toggle).toHaveFocus()

      await user.tab()
      expect(getRememberMe()).toHaveFocus()

      // "Forgot password?" link follows "Remember me" in the same row
      await user.tab()
      expect(forgotLink).toHaveFocus()

      await user.tab()
      expect(getSubmitButton()).toHaveFocus()

      // "Sign up" link after the submit button
      await user.tab()
      expect(signUpLink).toHaveFocus()
    })

    it('submits the form with Enter key on an input', async () => {
      const { user, onSubmit } = setup()
      await user.type(getEmailInput(), 'enter@test.com')
      await user.type(getPasswordInput(), 'p4ss')
      await user.keyboard('{Enter}')

      expect(onSubmit).toHaveBeenCalledWith({
        email: 'enter@test.com',
        password: 'p4ss',
        rememberMe: false,
      })
    })
  })

  // -----------------------------------------------------------------------
  // 8. ARIA attributes
  // -----------------------------------------------------------------------
  describe('accessibility', () => {
    it('has ARIA labels on email input', () => {
      setup()
      expect(getEmailInput()).toHaveAttribute('aria-label')
    })

    it('has ARIA labels on password input', () => {
      setup()
      expect(getPasswordInput()).toHaveAttribute('aria-label')
    })

    it('has ARIA label on password toggle button', () => {
      setup()
      const toggle = screen.getByRole('button', { name: /show password/i })
      expect(toggle).toHaveAttribute('aria-label')
    })

    it('associates error messages with inputs via aria-describedby', async () => {
      const { user } = setup()
      await user.click(getSubmitButton())

      const emailInput = getEmailInput()
      const describedBy = emailInput.getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()

      if (describedBy) {
        const errorEl = document.getElementById(describedBy)
        expect(errorEl).toBeInTheDocument()
        expect(errorEl).toHaveTextContent(/email is required/i)
      }
    })
  })

  // -----------------------------------------------------------------------
  // 9. Responsive behaviour (class-based tests via jsdom)
  // -----------------------------------------------------------------------
  describe('responsive layout', () => {
    it('has full-width inputs on mobile (class contains w-full)', () => {
      setup()
      expect(getEmailInput()).toHaveClass('w-full')
      expect(getPasswordInput()).toHaveClass('w-full')
    })

    it('renders inside a card container with max-w-md', () => {
      setup()
      // The outermost wrapper should have the max-w-md class
      const card = screen.getByTestId('login-card')
      expect(card).toHaveClass('max-w-md')
    })
  })
})
