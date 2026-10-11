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
import { TasksPage } from "./pages/Tasks.tsx";
import { MachinePage } from "./pages/machines/MachinePage.tsx";
import { Machines } from "./pages/machines/Machines.tsx";
import { Activity, Agents, ComingFromPaperclip, Costs, Decisions, Goals, Inbox, OrgConnectors, OrgSettings, Projects, Routines, Tasks } from "./pages/org/OrgPages.tsx";
import { OrgChart } from "./pages/org/OrgChart.tsx";

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
          <Route path="tasks" element={<TasksPage />} />
          <Route path="pin" element={<PinPage />} />
          <Route path="network" element={<NetworkPage />} />
          <Route path="firewall" element={<FirewallPage />} />
          <Route path="backups" element={<BackupsPage />} />
          <Route path="automations" element={<Automations />} />
          {/* Older addresses open the matching modal over Home. */}
          {["updates", "access", "connectors", "apps", "appearance"].map((id) => <Route key={id} path={id} element={<Navigate to={`../home?settings=${id}`} replace />} />)}
          <Route path="settings" element={<Navigate to="../home?settings=general" replace />} />
          <Route path="orgs/new" element={<Navigate to="../home?modal=new-org" replace />} />
          <Route path=":org">
            <Route index element={<OrgDashboard />} />
            <Route path="inbox" element={<Inbox />} />
            <Route path="decisions" element={<Decisions />} />
            <Route path="tasks" element={<Tasks />} />
            <Route path="projects" element={<Projects />} />
            <Route path="goals" element={<Goals />} />
            <Route path="routines" element={<Routines />} />
            <Route path="machines" element={<Machines />} />
            <Route path="machines/:vmid" element={<MachinePage />} />
            <Route path="agents" element={<Agents />} />
            <Route path="org" element={<OrgChart />} />
            <Route path="costs" element={<Costs />} />
            <Route path="activity" element={<Activity />} />
            <Route path="connectors" element={<OrgConnectors />} />
            <Route path="settings" element={<OrgSettings />} />
            <Route path="chat" element={<ComingFromPaperclip title="Chat" body="Talk with your agents in threads, with their runs and tool calls inline." />} />
            <Route path="artifacts" element={<ComingFromPaperclip title="Artifacts" body="Files, documents and outputs your agents produce, versioned per task." />} />
            <Route path="workspaces" element={<ComingFromPaperclip title="Workspaces" body="Code workspaces your agents work in, with diffs and branches." />} />
            <Route path="skills" element={<ComingFromPaperclip title="Skills" body="Reusable skills you can give your agents, from the skills catalog." />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Root />} />
    </Routes>
  );
}
