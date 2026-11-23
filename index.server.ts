import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getLayout, setLayout } from "./server/layout";
import { buildOverview } from "./server/overview";
import { getProjectIcons } from "./server/icons";
import { disposeReport, generateReport, getReport, initReport } from "./server/report/job";
import { getReportSettings, setReportSettings } from "./server/report/settings";
import { projectIconsRpc, reportGenerateRpc, reportGetRpc, reportSettingsGetRpc, reportSettingsSetRpc } from "./shared/report";
import { layoutGetRpc, layoutSetRpc, overviewRpc, timeframeRpc } from "./shared/rpc";
import { buildTimeframe } from "./server/timeframe";

export default function contribute(server: PluginServerContext) {
  server.handle(overviewRpc, buildOverview);
  server.handle(timeframeRpc, buildTimeframe);
  server.handle(layoutGetRpc, getLayout);
  server.handle(layoutSetRpc, setLayout);
  initReport();
  server.handle(reportGetRpc, getReport);
  server.handle(reportGenerateRpc, (input, context) => generateReport(input, context));
  server.handle(reportSettingsGetRpc, getReportSettings);
  server.handle(reportSettingsSetRpc, setReportSettings);
  server.handle(projectIconsRpc, getProjectIcons);
  // Stops and removes report helper agents still in flight.
  return () => disposeReport();
}
