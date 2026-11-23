import type { PluginScreenProps } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import type { Overview, Timeframe, TimeframeStats } from "../shared/rpc";
import { ActivityHeatmap } from "./activity";
import { FocusBlock } from "./focus";
import { ReportBlock, type ReportPart } from "./report/index";
import { DEFAULT_WIDGETS, WIDGETS, WidgetTile } from "./widgets";

// The contract between the grid (client/screen.tsx, client/grid/*) and the blocks.
// Every block on the dashboard is a top-level grid item: each widget tile, the activity heatmap,
// the focus block, Needs you, Shipped. The grid is GRID_COLS columns wide; a block's width is
// a whole number of columns. Heights follow content (no fixed row height).

export const GRID_COLS = 12;

export interface BlockContext {
  overview: Overview | undefined;
  stats: TimeframeStats | undefined;
  timeframe: Timeframe;
  /** Day range of the selected period, for highlighting in the heatmap. */
  period: { from: string; to: string } | undefined;
  todayKey: string;
  navigation: PluginScreenProps["navigation"];
  params: PluginScreenProps["params"];
  /** Host is a phone-sized layout. */
  compact: boolean;
  /** Pixel width the block is rendered at (0 until measured). Blocks adapt to it. */
  width: number;
  /** Columns the block spans right now (1..GRID_COLS). */
  cols: number;
}

export type BlockGroup = "widgets" | "sections";

export interface BlockDef {
  /** Stable id stored in the layout. Widget tiles are "w:<widgetId>". */
  id: string;
  title: string;
  icon: string;
  description: string;
  group: BlockGroup;
  /** Columns when added. */
  defaultW: number;
  /** Narrowest it may be resized to (columns). */
  minW: number;
  /** Widest (columns); default GRID_COLS. */
  maxW?: number;
  /** Needs ctx.stats (shows a placeholder until the timeframe loads). */
  needsStats: boolean;
  needsOverview?: boolean;
  render(ctx: BlockContext): ReactNode;
}

/** The block's pixel width; before the grid measures it, a guess from its columns (1 col ~ 89 px). */
function widthOf(ctx: BlockContext): number {
  return ctx.width > 0 ? ctx.width : Math.max(1, ctx.cols) * 89 - 12;
}

const widgetBlocks: BlockDef[] = WIDGETS.map((w) => ({
  id: "w:" + w.id,
  title: w.title,
  icon: w.icon,
  description: w.description,
  group: "widgets",
  defaultW: 2,
  minW: 2,
  maxW: 6,
  needsStats: true,
  render: (ctx) => <WidgetTile def={w} stats={ctx.stats!} todayKey={ctx.todayKey} width={widthOf(ctx)} />,
}));

const reportPart = (part: ReportPart) => (ctx: BlockContext) => (
  <ReportBlock part={part} compact={ctx.compact} navigation={ctx.navigation} params={ctx.params} period={ctx.timeframe} width={widthOf(ctx)} />
);

export const BLOCKS: BlockDef[] = [
  {
    id: "activity",
    title: "Activity",
    icon: "Activity",
    description: "A year of prompts as a heatmap, with your busiest day",
    group: "sections",
    defaultW: 12,
    minW: 6,
    needsStats: false,
    needsOverview: true,
    render: (ctx) => (
      <ActivityHeatmap overview={ctx.overview!} todayKey={ctx.todayKey} period={ctx.period} width={widthOf(ctx)} />
    ),
  },
  ...widgetBlocks,
  {
    id: "focus",
    title: "Where your focus went",
    icon: "Crosshair",
    description: "Every project of the period, its share and its days",
    group: "sections",
    defaultW: 12,
    minW: 6,
    needsStats: true,
    render: (ctx) => <FocusBlock stats={ctx.stats!} todayKey={ctx.todayKey} compact={ctx.compact} width={widthOf(ctx)} />,
  },
  {
    id: "needs-you",
    title: "Needs you",
    icon: "Hand",
    description: "What is waiting on you, written by agents on request",
    group: "sections",
    defaultW: 6,
    minW: 4,
    needsStats: false,
    render: reportPart("needs"),
  },
  {
    id: "shipped",
    title: "Shipped",
    icon: "CircleCheck",
    description: "What you finished in the period, written by agents on request",
    group: "sections",
    defaultW: 6,
    minW: 4,
    needsStats: false,
    render: reportPart("shipped"),
  },
];

/** Default layout, top to bottom. */
export const DEFAULT_ITEMS: { id: string; w: number }[] = [
  { id: "activity", w: 12 },
  ...DEFAULT_WIDGETS.map((id) => ({ id: "w:" + id, w: 2 })),
  { id: "focus", w: 12 },
  { id: "needs-you", w: 6 },
  { id: "shipped", w: 6 },
];

export const BLOCK_BY_ID: Record<string, BlockDef> = {};
for (const block of BLOCKS) BLOCK_BY_ID[block.id] = block;
