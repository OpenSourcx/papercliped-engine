import type { FeatureCtx, FeatureHandler } from "./index.ts";
import { automationRoutes } from "./pin-automations.ts";
import { planRoutes } from "./pin-agent.ts";
import { libraryRoutes } from "./pin-library.ts";
import { mcpRoute } from "./pin-mcp.ts";
import { notifyRoutes } from "./pin-notify.ts";
import { settingsRoute } from "./pin-settings.ts";
import { updateRoutes } from "./pin-update.ts";

/**
 * Pin's runtime, as routes: notifications, plans (Agent mode), automations and their runs, model settings tests, update
 * awareness and the read-only MCP endpoint. Each lives in its own file (pin-*.ts); docs/PIN.md describes them together.
 */
const ROUTES: ((ctx: FeatureCtx) => Promise<boolean>)[] = [notifyRoutes, planRoutes, automationRoutes, updateRoutes, settingsRoute, libraryRoutes, mcpRoute];

export const handlePin: FeatureHandler = async (ctx) => {
  if (!ctx.path.startsWith("/api/pin/") && ctx.path !== "/api/mcp") return false;
  for (const route of ROUTES) if (await route(ctx)) return true;
  return false;
};
