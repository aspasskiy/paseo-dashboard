// Pure grid model: layout migration, column maths, packing and drop targeting.
// No React and no catalog import (the registry is passed in).

import type { DashboardLayout, LayoutItem } from "../../shared/rpc";

export const GRID_GAP = 12;
const LAYOUT_VERSION = 3;
/** Below this inner width the grid collapses (widget tiles two per row, the rest full). */
const COMPACT_BELOW = 560;
/** Below this inner width nothing is narrower than MIN_ITEM_PX. */
const MEDIUM_BELOW = 860;
const MIN_ITEM_PX = 150;

export type Item = LayoutItem;

interface BlockSpec {
  minW: number;
  maxW?: number;
  defaultW: number;
  group: string;
}
type Registry = Record<string, BlockSpec | undefined>;

export function clampW(w: number, spec: BlockSpec | undefined, cols: number): number {
  const lo = Math.max(1, Math.min(cols, spec?.minW ?? 1));
  const hi = Math.max(lo, Math.min(cols, spec?.maxW ?? cols));
  const n = Math.round(Number.isFinite(w) ? w : cols);
  return Math.max(lo, Math.min(hi, n));
}

// --- Migration

/**
 * Any saved layout (v2, v3 or null) -> clean v3 items: migrated, unknown and repeated ids dropped,
 * widths clamped to each block's minW..maxW. Display only: the result is saved only when the user
 * changes something, so a layout is never rewritten on load.
 */
export function cleanLayout(layout: DashboardLayout | null | undefined, reg: Registry, defaults: Item[], defaultWidgets: string[], cols: number): Item[] {
  const items = !layout ? defaults : (layout.items ?? v2ToV3(layout.blocks ?? [], layout.widgets ?? defaultWidgets));
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const item of items) {
    const spec = reg[item.id];
    if (!spec || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({ id: item.id, w: clampW(item.w, spec, cols) });
  }
  return out;
}

/** v2: full/half blocks, one of them the "widgets" row, the report as one card. */
function v2ToV3(blocks: { id: string; size: string }[], widgets: string[]): Item[] {
  const items: Item[] = [];
  for (const b of blocks) {
    if (b.id === "widgets") for (const w of widgets) items.push({ id: "w:" + w, w: 2 });
    else if (b.id === "report") items.push({ id: "needs-you", w: 6 }, { id: "shipped", w: 6 });
    else items.push({ id: b.id, w: b.id === "focus" || b.size !== "half" ? 12 : 6 });
  }
  // The heatmap was a fixed header above everything; it is a block now.
  if (!items.some((i) => i.id === "activity")) items.unshift({ id: "activity", w: 12 });
  return items;
}

export function toSaved(items: Item[]): DashboardLayout {
  return { version: LAYOUT_VERSION, items: items.map((i) => ({ id: i.id, w: i.w })) };
}

// --- Column maths

export interface GridMode {
  /** Grid inner width in px. */
  inner: number;
  cols: number;
  gap: number;
  /** Phone-sized: widget tiles 6 columns, everything else full. */
  compact: boolean;
}

export function makeMode(inner: number, hostCompact: boolean, cols = 12, gap = GRID_GAP): GridMode {
  return { inner, cols, gap, compact: hostCompact || inner < COMPACT_BELOW };
}

export function colWidth(mode: GridMode): number {
  return Math.max(0, (mode.inner - mode.gap * (mode.cols - 1)) / mode.cols);
}

/** Pixel width of an item spanning `w` columns (a hair under, so a full row never wraps on float error). */
export function spanPx(mode: GridMode, w: number): number {
  const px = colWidth(mode) * w + mode.gap * (w - 1);
  return Math.max(0, Math.floor(px * 100) / 100 - 0.02);
}

export function pxToCols(mode: GridMode, px: number): number {
  return Math.round((px + mode.gap) / (colWidth(mode) + mode.gap));
}

/** Columns an item actually spans at this width (responsive collapse on narrow screens). */
export function effectiveW(item: Item, spec: BlockSpec | undefined, mode: GridMode): number {
  if (mode.compact) return spec?.group === "widgets" ? Math.ceil(mode.cols / 2) : mode.cols;
  let w = clampW(item.w, spec, mode.cols);
  if (mode.inner < MEDIUM_BELOW) w = Math.max(w, Math.min(mode.cols, pxToColsCeil(mode, MIN_ITEM_PX)));
  return w;
}

function pxToColsCeil(mode: GridMode, px: number): number {
  return Math.ceil((px + mode.gap) / (colWidth(mode) + mode.gap));
}

/** Width presets for the toolbar, limited to the block's range. */
export function presetsFor(spec: BlockSpec | undefined, cols = 12): { label: string; w: number }[] {
  const all = [
    { label: "¼", w: 3 },
    { label: "⅓", w: 4 },
    { label: "½", w: 6 },
    { label: "⅔", w: 8 },
    { label: "¾", w: 9 },
    { label: "Full", w: 12 },
  ];
  const lo = spec?.minW ?? 1;
  const hi = Math.min(cols, spec?.maxW ?? cols);
  return all.filter((p) => p.w >= lo && p.w <= hi);
}

// --- Packing and edits

/** Greedy left-to-right packing, the same rule flexWrap uses. */
export function pack(widths: number[], cols: number): { row: number; col: number }[] {
  let row = 0;
  let used = 0;
  return widths.map((w) => {
    if (used > 0 && used + w > cols) {
      row++;
      used = 0;
    }
    const at = { row, col: used };
    used += w;
    return at;
  });
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const next = list.slice();
  const [x] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, x);
  return next;
}

export function sameItems(a: Item[], b: Item[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.w === b[i].w);
}

// --- Drop targeting

interface Point {
  x: number;
  y: number;
}

/**
 * Where should the dragged item land? Simulates every insertion index with the real packing
 * rule and the item heights measured at drag start, and picks the slot under (or nearest to) the
 * pointer. It depends on the pointer only, not on the current preview, so it never oscillates.
 * `order` excludes the dragged item; returns an index into it (0..order.length).
 */
export function dropIndex(
  order: { w: number; h: number }[],
  dragged: { w: number; h: number },
  mode: GridMode,
  pointer: Point,
): number {
  const step = colWidth(mode) + mode.gap;
  let best = 0;
  let bestScore = Infinity;
  for (let j = 0; j <= order.length; j++) {
    const list = order.slice(0, j).concat([dragged], order.slice(j));
    const at = pack(
      list.map((x) => x.w),
      mode.cols,
    );
    const rowH: number[] = [];
    list.forEach((x, i) => (rowH[at[i].row] = Math.max(rowH[at[i].row] ?? 0, x.h)));
    let top = 0;
    for (let r = 0; r < at[j].row; r++) top += rowH[r] + mode.gap;
    const left = at[j].col * step;
    const width = dragged.w * step - mode.gap;
    const height = rowH[at[j].row];
    const dx = Math.max(left - pointer.x, 0, pointer.x - (left + width));
    const dy = Math.max(top - pointer.y, 0, pointer.y - (top + height));
    const cx = left + width / 2 - pointer.x;
    const cy = top + height / 2 - pointer.y;
    // Inside a slot beats near one; among equals, the closer centre wins.
    const score = Math.hypot(dx, dy) * 1e4 + Math.hypot(cx, cy);
    if (score < bestScore) {
      bestScore = score;
      best = j;
    }
  }
  return best;
}
