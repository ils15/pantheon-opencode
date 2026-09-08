/** Status/exit policy shared by installation validation and its tests. */
export const VALIDATION_STATUS = Object.freeze({
  PASS: 'PASS',
  WARN: 'WARN',
  ERROR: 'ERROR',
  SKIP: 'SKIP',
  AMBIENTAL: 'AMBIENTAL',
  NOT_TESTED: 'NOT_TESTED',
})

export function classifyDoctorExit(exitStatus, _output = '') {
  return Number.isInteger(exitStatus) && exitStatus === 0
    ? VALIDATION_STATUS.PASS
    : VALIDATION_STATUS.ERROR
}

export function classifyTuiExit(exitStatus) {
  return exitStatus === 0 ? VALIDATION_STATUS.PASS : VALIDATION_STATUS.ERROR
}

export function validationExitCode(doctorStatus, tuiStatus) {
  return doctorStatus === VALIDATION_STATUS.PASS && tuiStatus === VALIDATION_STATUS.PASS ? 0 : 1
}
