import { Navigate, Outlet, Route, Routes, useParams } from "react-router-dom";
import { useEngine } from "./data/store.tsx";
import { AppShell } from "./layout/AppShell.tsx";
import { Onboarding } from "./onboarding/Onboarding.tsx";
import { Access } from "./pages/Access.tsx";
import { Appearance } from "./pages/Appearance.tsx";
import { Apps } from "./pages/Apps.tsx";
import { Automations } from "./pages/Automations.tsx";
import { Connectors } from "./pages/Connectors.tsx";
import { Guests } from "./pages/Guests.tsx";
import { Home } from "./pages/Home.tsx";
import { NewOrg } from "./pages/NewOrg.tsx";
import { OrgDashboard } from "./pages/OrgDashboard.tsx";
import { Settings } from "./pages/Settings.tsx";
import { Updates } from "./pages/Updates.tsx";

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
          <Route path="updates" element={<Updates />} />
          <Route path="access" element={<Access />} />
          <Route path="connectors" element={<Connectors />} />
          <Route path="apps" element={<Apps />} />
          <Route path="appearance" element={<Appearance />} />
          <Route path="settings" element={<Settings />} />
          <Route path="orgs/new" element={<NewOrg />} />
          <Route path=":org" element={<OrgDashboard />} />
        </Route>
      </Route>
      <Route path="*" element={<Root />} />
    </Routes>
  );
}
