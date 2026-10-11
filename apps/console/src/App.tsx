import { Navigate, Outlet, Route, Routes, useParams } from "react-router-dom";
import { useEngine } from "./data/store.tsx";
import { AppShell } from "./layout/AppShell.tsx";
import { Onboarding } from "./onboarding/Onboarding.tsx";
import { Automations } from "./pages/Automations.tsx";
import { Guests } from "./pages/Guests.tsx";
import { Home } from "./pages/Home.tsx";
import { OrgDashboard } from "./pages/OrgDashboard.tsx";

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
          <Route path="guests" element={<Guests />} />
          <Route path="automations" element={<Automations />} />
          {/* Older addresses open the matching modal over Home. */}
          {["updates", "access", "connectors", "apps", "appearance"].map((id) => <Route key={id} path={id} element={<Navigate to={`../home?settings=${id}`} replace />} />)}
          <Route path="settings" element={<Navigate to="../home?settings=general" replace />} />
          <Route path="orgs/new" element={<Navigate to="../home?modal=new-org" replace />} />
          <Route path=":org" element={<OrgDashboard />} />
        </Route>
      </Route>
      <Route path="*" element={<Root />} />
    </Routes>
  );
}
