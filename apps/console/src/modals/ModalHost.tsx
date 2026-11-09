import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Bot, Cable, Container, KeyRound, LogIn, Palette, Plug, Settings as Gear, ShieldCheck } from "lucide-react";
import { CommunityPlugins } from "../pages/access/CommunityPlugins.tsx";
import { AccessHub } from "../pages/access/AccessHub.tsx";
import { Appearance } from "../pages/Appearance.tsx";
import { AgentSignIn } from "../pages/AgentSignIn.tsx";
import { Apps } from "../pages/Apps.tsx";
import { Connectors, LiveConnectors } from "../pages/Connectors.tsx";
import { LiveConnections } from "../pages/connect/LiveConnections.tsx";
import { AgentContainersSettings } from "../pages/containers/AgentContainers.tsx";
import { NewMachineModal } from "../pages/machines/NewMachine.tsx";
import { NewOrgModal } from "../pages/NewOrg.tsx";
import { StartCompany } from "../pages/start/StartCompany.tsx";
import { useEngine } from "../data/store.tsx";
import { QuickCreateModal } from "../pages/org/QuickCreate.tsx";
import { DownloadUrlModal, TemplatesModal, UploadModal } from "../pages/storage/StorageModals.tsx";
import { TaskLogModal } from "../pages/Tasks.tsx";
import { IfaceModal } from "../pages/network/Network.tsx";
import { CloneModal } from "../pages/machines/MachineClone.tsx";
import { MachineActionModal } from "../pages/machines/MachineActions.tsx";
import { BackupJobModal, BackupNowModal, RestoreModal } from "../pages/backups/Backups.tsx";
import { StoreItemModal } from "../pages/store/Store.tsx";
import { Settings } from "../pages/Settings.tsx";
import { NewAutomationModal } from "../pages/pin/runtime.tsx";
import { Vault } from "../pages/Vault.tsx";
import { AdoptWorkerModal } from "../pages/workers/AdoptWorker.tsx";
import { UseWorkerModal } from "../pages/workers/UseWorker.tsx";
import { SettingsModal, type SettingsSection } from "../ui/Modal.tsx";
import { useModals } from "./useModals.ts";

const SECTIONS: SettingsSection[] = [
  { id: "general", group: "Device", label: "General", icon: <Gear className="h-4 w-4" />, render: () => <Settings /> },
  { id: "access", group: "Access", label: "Access", icon: <ShieldCheck className="h-4 w-4" />, render: () => <AccessHub /> },
  { id: "apps", group: "Access", label: "Connected apps", icon: <Plug className="h-4 w-4" />, render: () => <Apps /> },
  { id: "connectors", group: "Device", label: "Connectors", icon: <Cable className="h-4 w-4" />, render: () => <Connectors /> },
  { id: "plugins", group: "Connectors", label: "Plugins", icon: <Cable className="h-4 w-4" />, hidden: true, render: () => <LiveConnectors /> },
  { id: "community-plugins", group: "Connectors", label: "Community plugins", icon: <Cable className="h-4 w-4" />, render: () => <CommunityPlugins /> },
  { id: "agent-models", group: "Connectors", label: "Providers", icon: <Bot className="h-4 w-4" />, hidden: true, render: () => <LiveConnections /> },
  { id: "agent-signin", group: "Access", label: "Agent sign-in", icon: <LogIn className="h-4 w-4" />, render: () => <AgentSignIn /> },
  { id: "vault", group: "Access", label: "Vault", icon: <KeyRound className="h-4 w-4" />, render: () => <Vault /> },
  { id: "agent-containers", group: "Access", label: "Agent containers", icon: <Container className="h-4 w-4" />, render: () => <AgentContainersSettings /> },
  { id: "appearance", group: "You", label: "Appearance", icon: <Palette className="h-4 w-4" />, render: () => <Appearance /> },
];

export const SETTINGS_IDS = SECTIONS.map((s) => s.id);

/** Renders whichever modal the URL asks for, over the current page. */
export function ModalHost() {
  const m = useModals();
  const live = useEngine().live;
  const [, setParams] = useSearchParams();
  // Old Advertising links land on Access, Remote access.
  useEffect(() => { if (m.settings === "advertising") setParams((p) => { const n = new URLSearchParams(p); n.set("settings", "access"); n.set("access", "remote"); return n; }, { replace: true }); }, [m.settings, setParams]);
  return (
    <>
      {m.settings !== null && <SettingsModal sections={SECTIONS} active={m.settings} onSelect={m.selectSection} onClose={m.modal === "new-org" ? m.closeSettings : m.close} />}
      {m.modal === "adopt-worker" && <AdoptWorkerModal onClose={m.close} />}
      {m.modal === "use-worker" && <UseWorkerModal onClose={m.close} />}
      {m.modal === "new-automation" && <NewAutomationModal onClose={m.close} />}
      {m.modal === "new-org" && (live ? <StartCompany onClose={m.close} /> : <NewOrgModal onClose={m.close} />)}
      {m.modal === "new-machine" && <NewMachineModal onClose={m.close} />}
      {m.modal === "upload" && <UploadModal onClose={m.close} />}
      {m.modal === "download-url" && <DownloadUrlModal onClose={m.close} />}
      {m.modal === "templates" && <TemplatesModal onClose={m.close} />}
      {m.modal === "task" && <TaskLogModal onClose={m.close} />}
      {m.modal === "backup-now" && <BackupNowModal onClose={m.close} />}
      {m.modal === "backup-job" && <BackupJobModal onClose={m.close} />}
      {m.modal === "restore" && <RestoreModal onClose={m.close} />}
      {m.modal === "iface" && <IfaceModal onClose={m.close} />}
      {m.modal === "clone" && <CloneModal onClose={m.close} />}
      {m.modal === "store-item" && <StoreItemModal onClose={m.close} />}
      {m.modal === "machine-action" && <MachineActionModal onClose={m.close} />}
      {(m.modal === "new-project" || m.modal === "new-goal" || m.modal === "new-routine") && <QuickCreateModal kind={m.modal} onClose={m.close} />}
    </>
  );
}
