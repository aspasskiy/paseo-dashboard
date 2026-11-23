import { Icon } from "@getpaseo/plugin/client/ui";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  ActivityIndicator,
  Animated,
  PanResponder,
  Platform,
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type PanResponderGestureState,
  type PanResponderInstance,
  type ScrollView,
} from "react-native";
import type { BlockContext, BlockDef } from "../catalog";
import { NUM, pressStyle, usePalette } from "../kit";
import { withAlpha } from "../theme";
import { injectCss, onKeyDown } from "./dom";
import {
  GRID_GAP,
  clampW,
  colWidth,
  dropIndex,
  effectiveW,
  makeMode,
  moveItem,
  presetsFor,
  pxToCols,
  spanPx,
  type GridMode,
  type Item,
} from "./model";

// The dashboard grid: every block is a direct child of one flexWrap row (keyed by id, so a block
// never remounts when it changes row) and spans whole columns. In Customize, blocks are dragged
// (whole block on desktop web, the grip on touch/compact), resized from the right edge with
// column snapping, and tuned from a floating toolbar. Nothing is saved until a gesture ends.

interface BlockStatus {
  ready: boolean;
  error: string | null;
}

/** What the grid needs from the screen's ScrollView for auto-scroll while dragging. */
export interface ScrollDriver {
  ref: RefObject<ScrollView | null>;
  /** The View wrapping the ScrollView (measured in window coords at drag start). */
  viewportRef: RefObject<View | null>;
  offset: { current: number };
  contentHeight: { current: number };
  setEnabled(enabled: boolean): void;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DragState {
  id: string;
  /** Preview index of the dragged item in the list. */
  index: number;
  from: number;
  start: Rect;
}

const EDGE = 56;
const MAX_SPEED = 18;
const THRESHOLD = 4;

/** Web: a block's root fills its cell, so blocks in a row share one height. */
function injectGridCss() {
  if (Platform.OS === "web") injectCss("dashboard-grid", "[data-gridbody] > * { flex-grow: 1; }");
}

export function Grid({
  items,
  registry,
  ctx,
  status,
  editing,
  hostCompact,
  scroll,
  selected,
  onSelect,
  onChange,
}: {
  items: Item[];
  registry: Record<string, BlockDef | undefined>;
  ctx: Omit<BlockContext, "width" | "cols">;
  status: { stats: BlockStatus; overview: BlockStatus };
  editing: boolean;
  hostCompact: boolean;
  scroll: ScrollDriver;
  selected: string | null;
  onSelect(id: string | null): void;
  onChange(next: Item[]): void;
}) {
  injectGridCss();
  const gridRef = useRef<View>(null);
  const [inner, setInner] = useState(0);
  const mode = makeMode(inner, hostCompact);
  const resizable = !mode.compact;
  const wholeDrag = Platform.OS === "web" && !mode.compact;
  const [drag, setDrag] = useState<DragState | null>(null);
  const [resize, setResize] = useState<{ id: string; w: number } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const rects = useRef<Record<string, Rect>>({});
  const ghost = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;

  // Rendered list: the drag preview, or the items with a live resize applied.
  const list = useMemo(() => {
    if (drag) return moveItem(items, drag.from, drag.index);
    if (resize) return items.map((i) => (i.id === resize.id ? { id: i.id, w: resize.w } : i));
    return items;
  }, [items, drag, resize]);

  // Everything the gesture handlers read lives in a ref: responders are created once per cell.
  const live = useRef({ items, mode, drag, editing, wholeDrag, resizable, registry, onChange, onSelect, selected });
  live.current = { items, mode, drag, editing, wholeDrag, resizable, registry, onChange, onSelect, selected };

  // Web keyboard: arrows move the selected block, shift+arrows resize it, Delete removes, Esc deselects.
  useEffect(() => {
    if (!editing || Platform.OS !== "web") return;
    return onKeyDown((e) => {
      const L = live.current;
      const id = L.selected;
      if (!id || L.drag) return;
      const index = L.items.findIndex((i) => i.id === id);
      if (index < 0) return;
      const item = L.items[index];
      const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
      const fwd = e.key === "ArrowRight" || e.key === "ArrowDown";
      if (e.key === "Escape") L.onSelect(null);
      else if ((e.key === "Delete" || e.key === "Backspace") && !e.metaKey && !e.ctrlKey) {
        L.onChange(L.items.filter((i) => i.id !== id));
        L.onSelect(null);
      } else if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && L.resizable) {
        const cur = effectiveW(item, L.registry[id], L.mode);
        const w = clampW(cur + (e.key === "ArrowRight" ? 1 : -1), L.registry[id], L.mode.cols);
        if (w !== item.w) L.onChange(L.items.map((i) => (i.id === id ? { id, w } : i)));
      } else if (!e.shiftKey && (back || fwd)) {
        const to = index + (fwd ? 1 : -1);
        if (to >= 0 && to < L.items.length) L.onChange(moveItem(L.items, index, to));
      } else return;
      e.preventDefault();
    });
  }, [editing]);

  const gesture = useRef<{
    gridWin: Rect | null;
    viewWin: Rect | null;
    pointer: { x: number; y: number };
    grab: { x: number; y: number };
    scroll0: number;
    heights: Record<string, number>;
    raf: number | null;
    started: boolean;
  }>({ gridWin: null, viewWin: null, pointer: { x: 0, y: 0 }, grab: { x: 0, y: 0 }, scroll0: 0, heights: {}, raf: null, started: false });

  const measure = () => {
    const g = gesture.current;
    g.gridWin = null;
    g.viewWin = null;
    gridRef.current?.measureInWindow((x, y, w, h) => (g.gridWin = { x, y, w, h }));
    scroll.viewportRef.current?.measureInWindow((x, y, w, h) => (g.viewWin = { x, y, w, h }));
    g.scroll0 = scroll.offset.current;
  };

  /** Pointer in grid coordinates (window coords minus the grid's window origin, plus scrolling since). */
  const toGrid = (wx: number, wy: number) => {
    const g = gesture.current;
    const win = g.gridWin!;
    return { x: wx - win.x, y: wy - win.y + (scroll.offset.current - g.scroll0) };
  };

  const updateTarget = () => {
    const g = gesture.current;
    const L = live.current;
    const d = L.drag;
    if (!d || !g.gridWin) return;
    const pt = toGrid(g.pointer.x, g.pointer.y);
    ghost.setValue({ x: pt.x - g.grab.x, y: pt.y - g.grab.y });
    const others = L.items.filter((i) => i.id !== d.id);
    const dims = (i: Item) => ({ w: effectiveW(i, L.registry[i.id], L.mode), h: g.heights[i.id] ?? 120 });
    const dragged = L.items[d.from];
    const j = dropIndex(others.map(dims), dims(dragged), L.mode, pt);
    if (j !== d.index) {
      const next = { ...d, index: j };
      live.current.drag = next;
      setDrag(next);
    }
  };

  const autoScroll = () => {
    const g = gesture.current;
    g.raf = null;
    if (!live.current.drag || !g.viewWin) return;
    const top = g.viewWin.y;
    const bottom = g.viewWin.y + g.viewWin.h;
    const y = g.pointer.y;
    let speed = 0;
    if (y < top + EDGE) speed = -MAX_SPEED * Math.min(1, (top + EDGE - y) / EDGE);
    else if (y > bottom - EDGE) speed = MAX_SPEED * Math.min(1, (y - (bottom - EDGE)) / EDGE);
    if (speed) {
      const max = Math.max(0, scroll.contentHeight.current - g.viewWin.h);
      const next = Math.max(0, Math.min(max, scroll.offset.current + speed));
      if (next !== scroll.offset.current) {
        scroll.offset.current = next;
        scroll.ref.current?.scrollTo({ y: next, animated: false });
        updateTarget();
      }
    }
    g.raf = requestAnimationFrame(autoScroll);
  };

  const beginDrag = (id: string) => {
    const g = gesture.current;
    const L = live.current;
    const start = rects.current[id];
    const from = L.items.findIndex((i) => i.id === id);
    if (!start || from < 0 || !g.gridWin) return false;
    g.heights = {};
    for (const i of L.items) g.heights[i.id] = rects.current[i.id]?.h ?? 120;
    const pt = toGrid(g.pointer.x, g.pointer.y);
    g.grab = { x: pt.x - start.x, y: pt.y - start.y };
    ghost.setValue({ x: start.x, y: start.y });
    const d = { id, index: from, from, start };
    live.current.drag = d;
    setDrag(d);
    L.onSelect(id);
    scroll.setEnabled(false);
    if (g.raf == null) g.raf = requestAnimationFrame(autoScroll);
    return true;
  };

  const endDrag = (commit: boolean) => {
    const g = gesture.current;
    if (g.raf != null) cancelAnimationFrame(g.raf);
    g.raf = null;
    scroll.setEnabled(true);
    const d = live.current.drag;
    if (d && commit) {
      updateTarget();
      const final = live.current.drag ?? d;
      if (final.index !== final.from) live.current.onChange(moveItem(live.current.items, final.from, final.index));
    }
    live.current.drag = null;
    setDrag(null);
  };

  useEffect(
    () => () => {
      const g = gesture.current;
      if (g.raf != null) cancelAnimationFrame(g.raf);
    },
    [],
  );

  // Drag responder: `grip` claims at once and never lets go; a whole-block one claims at once too
  // (a click selects, a move past THRESHOLD drags) but lets a scroll steal it before the drag starts.
  const makeDrag = (id: string, grip: boolean): PanResponderInstance => {
    const point = (e: GestureResponderEvent, gs: PanResponderGestureState) => {
      gesture.current.pointer = { x: gs.moveX || e.nativeEvent.pageX, y: gs.moveY || e.nativeEvent.pageY };
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => live.current.editing,
      onPanResponderTerminationRequest: () => !grip && !gesture.current.started && !live.current.wholeDrag,
      onPanResponderGrant: (e) => {
        gesture.current.started = false;
        gesture.current.pointer = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
        measure();
      },
      onPanResponderMove: (e, gs) => {
        point(e, gs);
        const g = gesture.current;
        const canDrag = grip || live.current.wholeDrag;
        if (!g.started) {
          if (!canDrag || Math.hypot(gs.dx, gs.dy) < THRESHOLD) return;
          g.started = beginDrag(id);
          return;
        }
        updateTarget();
      },
      onPanResponderRelease: (e, gs) => {
        const g = gesture.current;
        if (g.started) {
          point(e, gs);
          endDrag(true);
        } else {
          live.current.onSelect(id);
        }
        g.started = false;
      },
      onPanResponderTerminate: () => {
        if (gesture.current.started) endDrag(false);
        gesture.current.started = false;
      },
    });
  };

  const makeResize = (id: string): PanResponderInstance => {
    let startPx = 0;
    let current = 0;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => live.current.editing && live.current.resizable,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        const L = live.current;
        const item = L.items.find((i) => i.id === id);
        startPx = rects.current[id]?.w ?? 0;
        current = item ? effectiveW(item, L.registry[id], L.mode) : 1;
        L.onSelect(id);
        scroll.setEnabled(false);
        setResize({ id, w: current });
      },
      onPanResponderMove: (_e, gs) => {
        const L = live.current;
        const w = clampW(pxToCols(L.mode, startPx + gs.dx), L.registry[id], L.mode.cols);
        if (w !== current) {
          current = w;
          setResize({ id, w });
        }
      },
      onPanResponderRelease: () => {
        const L = live.current;
        scroll.setEnabled(true);
        setResize(null);
        const item = L.items.find((i) => i.id === id);
        if (item && item.w !== current) L.onChange(L.items.map((i) => (i.id === id ? { id, w: current } : i)));
      },
      onPanResponderTerminate: () => {
        scroll.setEnabled(true);
        setResize(null);
      },
    });
  };

  const onGridLayout = (e: LayoutChangeEvent) => setInner(e.nativeEvent.layout.width);
  const onCellLayout = (id: string, e: LayoutChangeEvent) => {
    const { x, y, width, height } = e.nativeEvent.layout;
    rects.current[id] = { x, y, w: width, h: height };
  };

  const remove = (id: string) => {
    onChange(items.filter((i) => i.id !== id));
    if (selected === id) onSelect(null);
  };
  const setWidth = (id: string, w: number) => onChange(items.map((i) => (i.id === id ? { id, w: clampW(w, registry[id], mode.cols) } : i)));

  const sel = editing && selected && !drag && !resize ? items.find((i) => i.id === selected) : undefined;
  const guides = editing && (drag || resize);

  return (
    <View
      ref={gridRef}
      onLayout={onGridLayout}
      style={[
        // zIndex: the ghost and the floating toolbar paint over the panel below the grid.
        { flexDirection: "row", flexWrap: "wrap", gap: GRID_GAP, alignItems: "stretch", position: "relative", zIndex: 2 },
        editing && Platform.OS === "web" ? ({ userSelect: "none" } as object) : null,
      ]}
    >
      {inner > 0
        ? (() => {
            // Rows as the flex wrap packs them. A widget tile sharing a row with a taller section keeps
            // its own height instead of stretching to the section's (equal heights only among likes).
            const top: Record<string, boolean> = {};
            let row: { id: string; group: string }[] = [];
            let used = 0;
            const flush = () => {
              const mixed = row.some((r) => r.group !== "widgets") && row.some((r) => r.group === "widgets");
              for (const r of row) if (mixed && r.group === "widgets") top[r.id] = true;
              row = [];
              used = 0;
            };
            for (const item of list) {
              const def = registry[item.id];
              if (!def) continue;
              const c = effectiveW(item, def, mode);
              if (used + c > mode.cols) flush();
              row.push({ id: item.id, group: def.group });
              used += c;
            }
            flush();
            return list.map((item) => {
            const def = registry[item.id];
            if (!def) return null;
            const cols = effectiveW(item, def, mode);
            const width = spanPx(mode, cols);
            return (
              <Cell
                key={item.id}
                id={item.id}
                def={def}
                ctx={ctx}
                status={status}
                width={width}
                cols={cols}
                alignTop={!!top[item.id]}
                editing={editing}
                wholeDrag={wholeDrag}
                resizable={resizable}
                dragging={drag?.id === item.id}
                resizing={resize?.id === item.id}
                selected={editing && selected === item.id}
                hovered={editing && hovered === item.id && !drag}
                onHover={(on) => setHovered((h) => (on ? item.id : h === item.id ? null : h))}
                onLayout={(e) => onCellLayout(item.id, e)}
                makeDrag={makeDrag}
                makeResize={makeResize}
                onRemove={() => remove(item.id)}
              />
            );
            });
          })()
        : null}

      {guides ? <ColumnGuides mode={mode} /> : null}

      {drag ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: drag.start.w,
            transform: ghost.getTranslateTransform(),
            zIndex: 20,
          }}
        >
          <Ghost def={registry[drag.id]} cols={effectiveW(items[drag.from], registry[drag.id], mode)} total={mode.cols} height={Math.min(drag.start.h, 96)} />
        </Animated.View>
      ) : null}

      {sel ? (
        <SelectionToolbar
          key={sel.id}
          item={sel}
          def={registry[sel.id]}
          mode={mode}
          rect={rects.current[sel.id]}
          resizable={resizable}
          index={items.indexOf(sel)}
          count={items.length}
          onWidth={(w) => setWidth(sel.id, w)}
          onMove={(delta) => onChange(moveItem(items, items.indexOf(sel), items.indexOf(sel) + delta))}
          onRemove={() => remove(sel.id)}
          onClose={() => onSelect(null)}
        />
      ) : null}
    </View>
  );
}

const BlockBody = memo(function BlockBody({
  def,
  ctx,
  status,
  width,
  cols,
}: {
  def: BlockDef;
  ctx: Omit<BlockContext, "width" | "cols">;
  status: { stats: BlockStatus; overview: BlockStatus };
  width: number;
  cols: number;
}) {
  const waiting = (def.needsStats && !status.stats.ready && status.stats) || (def.needsOverview && !status.overview.ready && status.overview);
  if (waiting) return <Placeholder error={waiting.error} />;
  return <>{def.render({ ...ctx, width, cols })}</>;
});

export function Placeholder({ error, height = 120 }: { error: string | null; height?: number }) {
  const p = usePalette();
  return (
    <View
      style={{
        minHeight: height,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        borderWidth: 1,
        borderColor: p.border,
        backgroundColor: p.card,
        padding: 12,
      }}
    >
      {error ? <Text style={{ color: p.danger, fontSize: 12, textAlign: "center" }}>{error}</Text> : <ActivityIndicator color={p.muted} />}
    </View>
  );
}

function Cell({
  id,
  def,
  ctx,
  status,
  width,
  cols,
  alignTop,
  editing,
  wholeDrag,
  resizable,
  dragging,
  resizing,
  selected,
  hovered,
  onHover,
  onLayout,
  makeDrag,
  makeResize,
  onRemove,
}: {
  id: string;
  def: BlockDef;
  ctx: Omit<BlockContext, "width" | "cols">;
  status: { stats: BlockStatus; overview: BlockStatus };
  width: number;
  cols: number;
  alignTop: boolean;
  editing: boolean;
  wholeDrag: boolean;
  resizable: boolean;
  dragging: boolean;
  resizing: boolean;
  selected: boolean;
  hovered: boolean;
  onHover(on: boolean): void;
  onLayout(e: LayoutChangeEvent): void;
  makeDrag(id: string, grip: boolean): PanResponderInstance;
  makeResize(id: string): PanResponderInstance;
  onRemove(): void;
}) {
  const p = usePalette();
  const cellDrag = useRef<PanResponderInstance | null>(null);
  const gripDrag = useRef<PanResponderInstance | null>(null);
  const edgeDrag = useRef<PanResponderInstance | null>(null);
  if (!cellDrag.current) cellDrag.current = makeDrag(id, false);
  if (!gripDrag.current) gripDrag.current = makeDrag(id, true);
  if (!edgeDrag.current) edgeDrag.current = makeResize(id);
  const web = Platform.OS === "web";
  const hoverProps = web && editing ? { onMouseEnter: () => onHover(true), onMouseLeave: () => onHover(false) } : {};
  // The chrome stays mounted while its block is dragged: the grip owns the gesture.
  const showChrome = editing && (dragging || hovered || selected || resizing || !wholeDrag);

  return (
    <View
      onLayout={onLayout}
      {...(editing ? cellDrag.current.panHandlers : {})}
      {...(hoverProps as object)}
      style={[
        { width, position: "relative", alignSelf: alignTop ? "flex-start" : "auto" },
        editing && web ? ({ cursor: wholeDrag ? (dragging ? "grabbing" : "grab") : "default" } as object) : null,
      ]}
    >
      <View
        {...({ dataSet: { gridbody: "" } } as object)}
        pointerEvents={editing ? "none" : "auto"}
        style={{ flexGrow: 1, opacity: dragging ? 0.25 : 1 }}
      >
        <BlockBody def={def} ctx={ctx} status={status} width={width} cols={cols} />
      </View>

      {editing ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: -4,
            right: -4,
            top: -4,
            bottom: -4,
            borderRadius: 11,
            borderWidth: 1,
            borderStyle: selected || dragging ? "solid" : "dashed",
            borderColor: dragging ? p.accent : selected || resizing ? p.accent : hovered ? p.muted : p.line,
            backgroundColor: dragging ? withAlpha(p.accent, 0.06) : "transparent",
          }}
        />
      ) : null}

      {showChrome ? (
        <View pointerEvents="box-none" style={{ position: "absolute", right: 8, top: 8, flexDirection: "row", alignItems: "center", gap: 4, zIndex: 4, opacity: dragging ? 0 : 1 }}>
          <View
            {...gripDrag.current.panHandlers}
            accessibilityLabel={"Move " + def.title}
            style={[
              {
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                height: 24,
                paddingHorizontal: 4,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: p.border,
                backgroundColor: p.card,
              },
              web ? ({ cursor: "grab" } as object) : null,
            ]}
          >
            <Icon name="GripVertical" size={14} color={p.muted} />
            {!wholeDrag && width > 220 ? (
              <Text style={{ color: p.muted, fontSize: 12, paddingRight: 4, maxWidth: 120 }} numberOfLines={1}>
                Move
              </Text>
            ) : null}
          </View>
          <ChromeButton icon="X" label={"Remove " + def.title} onPress={onRemove} />
        </View>
      ) : null}

      {editing && resizable && !dragging ? (
        <View
          {...edgeDrag.current.panHandlers}
          accessibilityLabel={"Resize " + def.title}
          style={[
            { position: "absolute", top: 0, bottom: 0, right: -10, width: 16, alignItems: "center", justifyContent: "center", zIndex: 5 },
            web ? ({ cursor: "ew-resize" } as object) : null,
          ]}
        >
          <View
            style={{
              width: 6,
              height: 28,
              maxHeight: "60%",
              borderRadius: 3,
              borderWidth: 1,
              borderColor: resizing || selected || hovered ? p.accent : p.line,
              backgroundColor: resizing ? p.accent : p.card,
              opacity: hovered || selected || resizing || !wholeDrag ? 1 : 0,
            }}
          />
        </View>
      ) : null}

      {resizing ? (
        <View pointerEvents="none" style={{ position: "absolute", right: 14, top: "50%", marginTop: -11, zIndex: 6 }}>
          <View style={{ paddingHorizontal: 8, height: 22, borderRadius: 999, justifyContent: "center", backgroundColor: p.accent }}>
            <Text style={[{ color: p.accentFg, fontSize: 12, fontWeight: "500" }, NUM]}>{cols + " / 12"}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function ChromeButton({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={pressStyle(({ hovered, pressed }) => ({
        width: 24,
        height: 24,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: p.border,
        backgroundColor: pressed ? p.pressed : hovered ? p.hover : p.card,
      }))}
    >
      <Icon name={icon} size={14} color={p.muted} />
    </Pressable>
  );
}

function ColumnGuides({ mode }: { mode: GridMode }) {
  const p = usePalette();
  const stripes = [];
  for (let i = 0; i < mode.cols; i++)
    stripes.push(
      <View
        key={i}
        style={{
          width: colWidth(mode),
          borderRadius: 4,
          backgroundColor: withAlpha(p.accent, p.dark ? 0.08 : 0.05),
          borderLeftWidth: 1,
          borderRightWidth: 1,
          borderColor: withAlpha(p.accent, 0.18),
        }}
      />,
    );
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: -4, bottom: -4, flexDirection: "row", gap: mode.gap, zIndex: 10 }}>
      {stripes}
    </View>
  );
}

function Ghost({ def, cols, total, height }: { def: BlockDef | undefined; cols: number; total: number; height: number }) {
  const p = usePalette();
  return (
    <View
      style={{
        height: Math.max(44, height),
        borderRadius: 8,
        borderWidth: 1,
        borderColor: p.accent,
        backgroundColor: p.card,
        padding: 12,
        gap: 4,
        opacity: 0.96,
        shadowColor: "#000",
        shadowOpacity: p.dark ? 0.3 : 0.1,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 6 },
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="GripVertical" size={14} color={p.muted} />
        {def ? <Icon name={def.icon} size={14} color={p.muted} /> : null}
        <Text style={{ color: p.fg, fontSize: 13, fontWeight: "500", flexShrink: 1 }} numberOfLines={1}>
          {def?.title ?? ""}
        </Text>
      </View>
      <Text style={[{ color: p.muted, fontSize: 12 }, NUM]}>{cols + " / " + total}</Text>
    </View>
  );
}

function SelectionToolbar({
  item,
  def,
  mode,
  rect,
  resizable,
  index,
  count,
  onWidth,
  onMove,
  onRemove,
  onClose,
}: {
  item: Item;
  def: BlockDef | undefined;
  mode: GridMode;
  rect: Rect | undefined;
  resizable: boolean;
  index: number;
  count: number;
  onWidth(w: number): void;
  onMove(delta: number): void;
  onRemove(): void;
  onClose(): void;
}) {
  const p = usePalette();
  const [ownW, setOwnW] = useState(0);
  if (!rect || !def) return null;
  const w = effectiveW(item, def, mode);
  const presets = presetsFor(def, mode.cols);
  const lo = Math.max(1, def.minW);
  const hi = Math.min(mode.cols, def.maxW ?? mode.cols);
  const above = rect.y >= 40;
  const left = Math.max(0, Math.min(rect.x, mode.inner - ownW));
  return (
    <View
      onLayout={(e) => setOwnW(e.nativeEvent.layout.width)}
      style={{
        position: "absolute",
        left,
        top: above ? rect.y - 40 : rect.y + rect.h + 8,
        zIndex: 30,
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        padding: 3,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: p.border,
        backgroundColor: p.card,
        shadowColor: "#000",
        shadowOpacity: p.dark ? 0.2 : 0.06,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
      }}
    >
      <Text style={{ color: p.fg, fontSize: 12, fontWeight: "500", paddingHorizontal: 6, maxWidth: 160 }} numberOfLines={1}>
        {def.title}
      </Text>
      <Divider />
      <ToolButton icon="ChevronLeft" label="Move earlier" onPress={() => onMove(-1)} disabled={index <= 0} />
      <ToolButton icon="ChevronRight" label="Move later" onPress={() => onMove(1)} disabled={index >= count - 1} />
      {resizable ? (
        <>
          <Divider />
          <ToolButton icon="Minus" label="Narrower" onPress={() => onWidth(w - 1)} disabled={w <= lo} />
          <Text style={[{ color: p.muted, fontSize: 12, minWidth: 36, textAlign: "center" }, NUM]}>{w + "/" + mode.cols}</Text>
          <ToolButton icon="Plus" label="Wider" onPress={() => onWidth(w + 1)} disabled={w >= hi} />
          {presets.length > 1 && mode.inner >= 520 ? (
            <>
              <Divider />
              {presets.map((pr) => (
                <ToolButton key={pr.w} text={pr.label} label={pr.w + " columns"} active={pr.w === w} onPress={() => onWidth(pr.w)} />
              ))}
            </>
          ) : null}
        </>
      ) : null}
      <Divider />
      <ToolButton icon="Trash2" label="Remove" onPress={onRemove} />
      <ToolButton icon="X" label="Close" onPress={onClose} />
    </View>
  );
}

function Divider() {
  const p = usePalette();
  return <View style={{ width: 1, height: 16, backgroundColor: p.border, marginHorizontal: 2 }} />;
}

function ToolButton({
  icon,
  text,
  label,
  onPress,
  disabled,
  active,
}: {
  icon?: string;
  text?: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
}): ReactNode {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      onPress={onPress}
      style={pressStyle(({ hovered, pressed }) => ({
        minWidth: 24,
        height: 24,
        paddingHorizontal: text ? 6 : 0,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.35 : 1,
        backgroundColor: active ? p.hover : pressed ? p.pressed : hovered ? p.hover : "transparent",
        borderWidth: 1,
        borderColor: active ? p.border : "transparent",
      }))}
    >
      {icon ? <Icon name={icon} size={14} color={p.muted} /> : <Text style={{ color: active ? p.fg : p.muted, fontSize: 12, fontWeight: active ? "500" : "400" }}>{text}</Text>}
    </Pressable>
  );
}
