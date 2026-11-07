import { useSearchParams } from "react-router-dom";
import { Access } from "../Access.tsx";
import { PageFrame, PageHeader, Segmented } from "../../ui/primitives.tsx";
import { RemoteAccess } from "./RemoteAccess.tsx";

export type AccessTab = "people" | "remote";

/** Settings → Access: one destination for who may use this device (people and permissions) and how it is reached from outside (remote access). */
export function AccessHub() {
  const [params, setParams] = useSearchParams();
  const tab: AccessTab = params.get("access") === "remote" ? "remote" : "people";
  const select = (v: AccessTab) => setParams((p) => { const n = new URLSearchParams(p); n.set("access", v); return n; }, { replace: true });
  return <>
    <PageFrame width="6xl"><div className="mb-4"><Segmented value={tab} onChange={select} label="Access sections" options={[{ value: "people", label: "People and permissions" }, { value: "remote", label: "Remote access" }]} /></div></PageFrame>
    {tab === "people" ? <Access /> : <PageFrame width="4xl"><PageHeader title="Remote access" subtitle="Local only, your own Cloudflare account, or Papercliped Connect. Machine-wide, managed only by device administrators." /><RemoteAccess /></PageFrame>}
  </>;
}
