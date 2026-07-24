export interface LoginData {
  email: string
  password: string
  rememberMe: boolean
}

export interface LoginFormProps {
  /** Called with credentials when the form is submitted and passes validation */
  onSubmit: (data: LoginData) => void | Promise<void>
  /** Puts the submit button into a loading/disabled state */
  isLoading?: boolean
  /** An external error message to display above the form fields */
  error?: string | null
}
