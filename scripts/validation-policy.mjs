/** Status/exit policy shared by installation validation and its tests. */
export const VALIDATION_STATUS = Object.freeze({ PASS: 'PASS', WARN: 'WARN', ERROR: 'ERROR', SKIP: 'SKIP' })

export function classifyDoctorExit(exitStatus, output = '') {
  if (exitStatus === 0) return VALIDATION_STATUS.PASS
  if (exitStatus === 1 && !/(?:❌\s*)?[1-9]\d*\s+errors?/i.test(output)) {
    return VALIDATION_STATUS.WARN
  }
  return VALIDATION_STATUS.ERROR
}

export function classifyTuiExit(exitStatus) {
  return exitStatus === 0 ? VALIDATION_STATUS.PASS : VALIDATION_STATUS.ERROR
}

export function validationExitCode(doctorStatus, tuiStatus) {
  return doctorStatus === VALIDATION_STATUS.ERROR || tuiStatus === VALIDATION_STATUS.ERROR ? 1 : 0
}
