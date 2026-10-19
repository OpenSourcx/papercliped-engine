import { Cable, Container, KeyRound, Palette, Plug, RefreshCw, Settings as Gear, ShieldCheck } from "lucide-react";
import { Access } from "../pages/Access.tsx";
import { Appearance } from "../pages/Appearance.tsx";
import { Apps } from "../pages/Apps.tsx";
import { Connectors } from "../pages/Connectors.tsx";
import { AgentContainersSettings } from "../pages/containers/AgentContainers.tsx";
import { NewMachineModal } from "../pages/machines/NewMachine.tsx";
import { NewOrgModal } from "../pages/NewOrg.tsx";
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
import { Updates } from "../pages/Updates.tsx";
import { Vault } from "../pages/Vault.tsx";
import { SettingsModal, type SettingsSection } from "../ui/Modal.tsx";
import { useModals } from "./useModals.ts";

const SECTIONS: SettingsSection[] = [
  { id: "general", group: "Device", label: "General", icon: <Gear className="h-4 w-4" />, render: () => <Settings /> },
  { id: "updates", group: "Device", label: "Updates", icon: <RefreshCw className="h-4 w-4" />, render: () => <Updates /> },
  { id: "access", group: "Access", label: "Access control", icon: <ShieldCheck className="h-4 w-4" />, render: () => <Access /> },
  { id: "apps", group: "Access", label: "Connected apps", icon: <Plug className="h-4 w-4" />, render: () => <Apps /> },
  { id: "connectors", group: "Access", label: "Connectors", icon: <Cable className="h-4 w-4" />, render: () => <Connectors /> },
  { id: "vault", group: "Access", label: "Vault", icon: <KeyRound className="h-4 w-4" />, render: () => <Vault /> },
  { id: "agent-containers", group: "Access", label: "Agent containers", icon: <Container className="h-4 w-4" />, render: () => <AgentContainersSettings /> },
  { id: "appearance", group: "You", label: "Appearance", icon: <Palette className="h-4 w-4" />, render: () => <Appearance /> },
];

export const SETTINGS_IDS = SECTIONS.map((s) => s.id);

/** Renders whichever modal the URL asks for, over the current page. */
export function ModalHost() {
  const m = useModals();
  return (
    <>
      {m.settings !== null && <SettingsModal sections={SECTIONS} active={m.settings} onSelect={m.selectSection} onClose={m.close} />}
      {m.modal === "new-automation" && <NewAutomationModal onClose={m.close} />}
      {m.modal === "new-org" && <NewOrgModal onClose={m.close} />}
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
