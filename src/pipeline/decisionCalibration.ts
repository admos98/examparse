/** Calibration is evidence about a specific referee, never a claim inferred from scripted tests. */
export interface CalibrationCounts { catches: number; planted: number; falseAlarms: number; clean: number }
export interface DecisionCalibrationReport {
  version: 'decide-calibration-v1'; mode: 'scripted' | 'live'; fixture: string; measuredAt: string;
  endpointHost: string; model: string; dialect: 'thx' | 'jev';
  counts: CalibrationCounts; perKind: Record<string, CalibrationCounts>;
  endpointErrors: number; skippedNoEvidence: number;
}
export function parseDecisionCalibrationReport(value: unknown): DecisionCalibrationReport {
  const r = value as DecisionCalibrationReport;
  const counts = (c: CalibrationCounts) => c && (['catches', 'planted', 'falseAlarms', 'clean'] as const).every(k => Number.isInteger(c[k]) && c[k] >= 0) && c.catches <= c.planted && c.falseAlarms <= c.clean;
  if (!r || r.version !== 'decide-calibration-v1' || !['live', 'scripted'].includes(r.mode) ||
    ![r.fixture, r.endpointHost, r.model, r.measuredAt].every(v => typeof v === 'string' && v.length > 0) ||
    !Number.isFinite(Date.parse(r.measuredAt)) || !['thx', 'jev'].includes(r.dialect) || !counts(r.counts) ||
    !r.perKind || typeof r.perKind !== 'object' || !Object.values(r.perKind).every(counts) ||
    ![r.endpointErrors, r.skippedNoEvidence].every(v => Number.isInteger(v) && v >= 0)) throw new Error('Invalid calibration report');
  return r;
}
export function calibrationSummary(report?: DecisionCalibrationReport, model?: string, endpointHost?: string, dialect?: string): string {
  if (!report || report.mode !== 'live' || report.model !== model || report.endpointHost !== endpointHost || report.dialect !== dialect)
    return 'No live calibration measured for this endpoint/model. Stay in shadow until you have reviewed a live report.';
  const c = report.counts;
  return `Measured on ${report.fixture}: catches ${c.catches}/${c.planted} planted errors, false indictments ${c.falseAlarms}/${c.clean} clean items (${report.measuredAt}). ${report.endpointErrors} endpoint errors; ${report.skippedNoEvidence} skipped-no-evidence.`;
}
