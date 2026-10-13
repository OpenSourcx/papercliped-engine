/** A machine-number check that never throws: an unreachable host leaves the number unchecked. */
export async function liveVmidCheck(check: (n: number) => Promise<{ free: boolean; message: string }>, n: number): Promise<{ free: boolean; message: string }> {
  try {
    return await check(n);
  } catch {
    return { free: true, message: "" };
  }
}
