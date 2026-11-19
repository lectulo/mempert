/** Gate new OpenRouter Batch submissions, not ordinary ZIP processing or completion of accepted batches. */
export function batchEnabled(env: { BATCH_ENABLED?: string }): boolean {
  const value = env.BATCH_ENABLED?.trim().toLowerCase();
  if (!value || value === "true") return true;
  if (value === "false") return false;
  throw new Error("BATCH_ENABLED must be true or false");
}
