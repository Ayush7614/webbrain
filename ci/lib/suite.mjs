export function resolveCloudRunId(started = {}) {
  return started.run_id || started.runId || started.id || '';
}

export function suiteShouldFail(totals = {}) {
  return Number(totals.failed || 0) > 0 || Number(totals.skipped || 0) > 0;
}
