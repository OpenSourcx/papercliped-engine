import { Navigate, Outlet, Route, Routes, useParams } from "react-router-dom";
import { useEngine } from "./data/store.tsx";
import { AppShell } from "./layout/AppShell.tsx";
import { Onboarding } from "./onboarding/Onboarding.tsx";
import { Automations } from "./pages/Automations.tsx";
import { Home } from "./pages/Home.tsx";
import { OrgDashboard } from "./pages/OrgDashboard.tsx";
import { HostShell, StoragePage, Summary } from "./pages/DevicePages.tsx";
import { Resources } from "./pages/Resources.tsx";
import { StorageDetail } from "./pages/storage/StorageDetail.tsx";
import { BackupsPage } from "./pages/backups/Backups.tsx";
import { PinPage } from "./pages/pin/PinPage.tsx";
import { NetworkPage } from "./pages/network/Network.tsx";
import { FirewallPage } from "./pages/firewall/Firewall.tsx";
import { FEATURES } from "./features/registry.ts";
import { Store } from "./pages/store/Store.tsx";
import { TasksPage } from "./pages/Tasks.tsx";
import { MachinePage } from "./pages/machines/MachinePage.tsx";
import { Machines } from "./pages/machines/Machines.tsx";
import { Activity, Agents, Artifacts, ComingFromPaperclip, Costs, Decisions, Goals, Inbox, OrgConnectors, OrgSettings, Projects, Routines, Skills, Tasks, Workspaces } from "./pages/org/OrgPages.tsx";
import { OrgChart } from "./pages/org/OrgChart.tsx";
import { OrgRoute } from "./pages/org/live/common.tsx";
import { LiveAgentDetail } from "./pages/org/live/LiveAgents.tsx";
import { LiveTaskDetail } from "./pages/org/live/LiveTasks.tsx";
import { LiveMembers } from "./pages/org/live/LiveWork.tsx";
import { LiveWorkspaceDetail } from "./pages/org/live/LiveArtifacts.tsx";
import { LiveRoutineDetail } from "./pages/org/live/LiveRoutines.tsx";

/** Pages only the engine has (a task's thread, an agent's runs, the member list). The demo goes back to the list instead. */
function LiveOnly({ children, fallback }: { children: React.ReactNode; fallback: string }) {
  return useEngine().live ? <>{children}</> : <Navigate to={fallback} replace />;
}

/** Everything under /<device>/ needs a finished setup and the right device name; anything else is redirected. */
function DeviceGate() {
  const { setup } = useEngine();
  const { device } = useParams();
  if (!setup) return <Navigate to="/setup" replace />;
  if (device !== setup.deviceName) return <Navigate to={`/${setup.deviceName}/home`} replace />;
  return <Outlet />;
}

function Root() {
  const { setup } = useEngine();
  return <Navigate to={setup ? `/${setup.deviceName}/home` : "/setup"} replace />;
}

function SetupGate() {
  const { setup } = useEngine();
  return setup ? <Navigate to={`/${setup.deviceName}/home`} replace /> : <Onboarding />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Root />} />
      <Route path="/setup" element={<SetupGate />} />
      <Route path="/:device" element={<DeviceGate />}>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="home" replace />} />
          <Route path="home" element={<Home />} />
          <Route path="machines" element={<Machines />} />
          <Route path="machines/:vmid" element={<MachinePage />} />
          <Route path="guests" element={<Navigate to="../machines" replace />} />
          <Route path="shell" element={<HostShell />} />
          <Route path="summary" element={<Summary />} />
          <Route path="resources" element={<Resources />} />
          <Route path="storage" element={<StoragePage />} />
          <Route path="storage/:id" element={<StorageDetail />} />
          <Route path="store" element={<Store />} />
          <Route path="library" element={<Navigate to="../store" replace />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="pin" element={<PinPage />} />
          <Route path="network" element={<NetworkPage />} />
          <Route path="firewall" element={<FirewallPage />} />
          <Route path="backups" element={<BackupsPage />} />
          <Route path="automations" element={<Automations />} />
          {FEATURES.flatMap((f) => f.routes.map((r) => <Route key={`${f.id}:${r.path}`} path={r.path} element={r.element} />))}
          {/* Older addresses open the matching modal over Home. */}
          {["updates", "access", "connectors", "apps", "appearance"].map((id) => <Route key={id} path={id} element={<Navigate to={`../home?settings=${id}`} replace />} />)}
          <Route path="settings" element={<Navigate to="../home?settings=general" replace />} />
          <Route path="orgs/new" element={<Navigate to="../home?modal=new-org" replace />} />
          <Route path=":org" element={<OrgRoute />}>
            <Route index element={<OrgDashboard />} />
            <Route path="inbox" element={<Inbox />} />
            <Route path="decisions" element={<Decisions />} />
            <Route path="tasks" element={<Tasks />} />
            <Route path="tasks/:taskId" element={<LiveOnly fallback="..">{<LiveTaskDetail />}</LiveOnly>} />
            <Route path="projects" element={<Projects />} />
            <Route path="goals" element={<Goals />} />
            <Route path="routines" element={<Routines />} />
            <Route path="routines/:routineId" element={<LiveOnly fallback="..">{<LiveRoutineDetail />}</LiveOnly>} />
            <Route path="machines" element={<Machines />} />
            <Route path="machines/:vmid" element={<MachinePage />} />
            <Route path="agents" element={<Agents />} />
            <Route path="agents/:agentId" element={<LiveOnly fallback="..">{<LiveAgentDetail />}</LiveOnly>} />
            <Route path="members" element={<LiveOnly fallback="..">{<LiveMembers />}</LiveOnly>} />
            <Route path="org" element={<OrgChart />} />
            <Route path="costs" element={<Costs />} />
            <Route path="activity" element={<Activity />} />
            <Route path="connectors" element={<OrgConnectors />} />
            <Route path="settings" element={<OrgSettings />} />
            <Route path="chat" element={<ComingFromPaperclip title="Chat" body="Talk with your agents in threads, with their runs and tool calls inline." />} />
            <Route path="artifacts" element={<Artifacts />} />
            <Route path="workspaces" element={<Workspaces />} />
            <Route path="workspaces/:workspaceId" element={<LiveOnly fallback="..">{<LiveWorkspaceDetail />}</LiveOnly>} />
            <Route path="skills" element={<Skills />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Root />} />
    </Routes>
  );
}
