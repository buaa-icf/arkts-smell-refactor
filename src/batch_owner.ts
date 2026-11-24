/** Attach ownership evidence only to operations started by a batch case. */
export function batchRecoveryOwner(): { pid: number; batchRecoveryToken: string } | undefined {
  const token = process.env.ARKTS_BATCH_RECOVERY_TOKEN;
  if (token && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(token))
    return { pid: process.pid, batchRecoveryToken: token };
}
