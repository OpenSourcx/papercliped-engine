/**
 * What to do when starting a sign-in fails. The sign-in runs in a container of the organization's own resource group,
 * so the usual cause of a bare server error is that the group has no room for one more container. Whatever message the
 * server gives is still shown first; this adds what a person can do about it, so the dialog is never a dead end.
 */
export function signInFailureHelp(message: string): string {
  const m = message.toLowerCase();
  if (/session ended|sign in again/.test(m)) return "Sign in to ePaperclip again, then retry.";
  if (/quota|limit|capacity|no room|full|too many|resource group|out of (memory|disk|cpu)/.test(m)) {
    return "This organization's resource group has no room for another agent container. Stop or delete a container the organization no longer needs (Machines), or ask an administrator to raise the group's limits (Settings, Agent containers). Then try again.";
  }
  if (/not found|no (agent )?container|environment/.test(m)) {
    return "The organization has no working agent container. An administrator can check Settings, Agent containers. Then try again.";
  }
  if (/forbidden|not allowed|permission|only .*admin/.test(m)) return "Only the organization's owners and Proxmox administrators can sign in an account.";
  if (/internal server error|bad gateway|unavailable|timed out|timeout|failed to fetch|network/.test(m) || m.trim() === "") {
    return "The sign-in couldn't start. The most common cause is that the organization's resource group has no room for one more agent container: stop or delete a container the organization no longer needs (Machines), or check Settings, Agent containers. Then try again.";
  }
  return "Check Settings, Agent containers, then try again.";
}
