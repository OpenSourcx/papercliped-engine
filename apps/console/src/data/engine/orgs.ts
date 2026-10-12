import { useMemo } from "react";
import type { Org } from "../types.ts";
import { mapCompany } from "./map.ts";
import { useAgentsOf, useOrgs, useResourceGroups } from "./queries.ts";

export interface LiveOrgs {
  /** Null until the first answer; an empty list means the person really has no organizations. */
  orgs: Org[] | null;
  error: unknown;
}

/** The signed-in person's organizations from the engine, in the console's shape, with their agents and resource groups. */
export function useLiveOrgs(): LiveOrgs {
  const companies = useOrgs();
  const list = useMemo(() => (companies.data ?? []).filter((c) => c.status !== "archived"), [companies.data]);
  const ids = useMemo(() => list.map((c) => c.id), [list]);
  const agents = useAgentsOf(ids);
  const groups = useResourceGroups();
  // The query result arrays are rebuilt every render; this changes only when one of their answers does.
  const sig = `${agents.map((a) => a.dataUpdatedAt).join(",")}|${groups.dataUpdatedAt}${groups.isError ? "e" : ""}`;
  const orgs = useMemo(
    () => (companies.data ? list.map((c, i) => mapCompany(c, agents[i]?.data, groups.data ? groups.data.find((g) => g.companyId === c.id) ?? null : undefined)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [companies.data, list, sig],
  );
  return { orgs, error: companies.error };
}
