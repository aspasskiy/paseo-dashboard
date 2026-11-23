import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { DashboardScreen } from "./client/screen";

const SCREEN_ID = "home";

function DashboardSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="LayoutDashboard"
      label="Dashboard"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const stopScreen = client.addScreen({ id: SCREEN_ID, title: "Dashboard", Component: DashboardScreen });
  const stopSidebar = client.addSidebarHeaderItem({ id: "dashboard", title: "Dashboard", Component: DashboardSidebarItem });
  const stopCommand = client.addCommandCenterItem({
    id: "open-dashboard",
    title: "Open Dashboard",
    icon: "LayoutDashboard",
    keywords: ["dashboard", "home", "activity", "focus", "report", "stats"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });
  return () => {
    void stopCommand();
    void stopSidebar();
    void stopScreen();
  };
}
