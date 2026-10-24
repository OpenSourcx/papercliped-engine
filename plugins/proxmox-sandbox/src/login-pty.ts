import { shellQuote } from "./ssh.js";

/**
 * The sign-in commands Paperclip may start in a container. The host sends only a key, never a command line, so the
 * command is fixed here. Each runs with its own throwaway home (`sessionHome`) so the credentials it writes stay apart
 * from anything else in the container, and Paperclip reads them back from there.
 */
export type LoginCommandKey = "claude" | "codex" | "grok";

const HOME = /^\/tmp\/paperclip-adapter-login\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COMMANDS: Record<LoginCommandKey, { env: string; run: string }> = {
  claude: { env: "CLAUDE_CONFIG_DIR", run: "claude setup-token" },
  codex: { env: "CODEX_HOME", run: "codex login --device-auth" },
  grok: { env: "GROK_HOME", run: "grok login --device-auth" },
};

export function isLoginCommandKey(value: unknown): value is LoginCommandKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(COMMANDS, value);
}

/** The remote command line for one login, or an Error naming what is wrong (unknown key, a home that isn't Paperclip's shape). */
export function loginCommandLine(key: unknown, sessionHome: unknown): string {
  if (!isLoginCommandKey(key)) throw new Error("That login isn't supported in these containers.");
  if (typeof sessionHome !== "string" || !HOME.test(sessionHome)) throw new Error("The login's working folder isn't in the expected form.");
  const c = COMMANDS[key];
  const home = shellQuote(sessionHome);
  return `sh -c ${shellQuote(`umask 077; mkdir -p ${home} && cd ${home} && export TERM=xterm-256color ${c.env}=${home} && exec ${c.run}`)}`;
}
