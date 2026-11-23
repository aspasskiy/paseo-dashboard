import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { layoutGetRpc, layoutSetRpc, overviewRpc, timeframeRpc, type DashboardLayout, type Timeframe } from "../shared/rpc";
import { BLOCKS, BLOCK_BY_ID, DEFAULT_ITEMS, GRID_COLS, type BlockContext, type BlockDef, type BlockGroup } from "./catalog";
import { localDayKey } from "./format";
import { onKeyDown } from "./grid/dom";
import { Grid, Placeholder, type ScrollDriver } from "./grid/Grid";
import { cleanLayout, sameItems, toSaved, type Item } from "./grid/model";
import { NUM, PaletteContext, Segmented, TextButton, pressStyle, usePalette } from "./kit";
import { makePalette } from "./theme";
import { DEFAULT_WIDGETS, TIMEFRAMES } from "./widgets";

const MAX_WIDTH = 1120;
const GAP = 12;
const UNDO_DEPTH = 30;

// Every block on the dashboard is a top-level item of a 12-column grid (client/grid). The period
// switch in the header is global and fixed; the blocks themselves come from ./catalog.

function clean(layout: DashboardLayout | null | undefined): Item[] {
  return cleanLayout(layout, BLOCK_BY_ID, DEFAULT_ITEMS, DEFAULT_WIDGETS, GRID_COLS);
}

export function DashboardScreen(props: PluginScreenProps) {
  const palette = useMemo(() => makePalette(props.theme), [props.theme]);
  return (
    <PaletteContext.Provider value={palette}>
      <Dashboard {...props} />
    </PaletteContext.Provider>
  );
}

function useOverview() {
  const fetchOverview = useRpc(overviewRpc);
  return useQuery({
    queryKey: ["dashboard", "overview"],
    queryFn: () => fetchOverview({ tzOffsetMinutes: new Date().getTimezoneOffset() }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

function useTimeframe(timeframe: Timeframe) {
  const fetchTimeframe = useRpc(timeframeRpc);
  return useQuery({
    queryKey: ["dashboard", "timeframe", timeframe],
    queryFn: () => fetchTimeframe({ timeframe, tzOffsetMinutes: new Date().getTimezoneOffset() }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

function initialTimeframe(params: PluginScreenProps["params"]): Timeframe {
  const asked = params?.timeframe;
  return TIMEFRAMES.some((t) => t.id === asked) ? (asked as Timeframe) : "week";
}

/**
 * The saved layout, migrated to grid items for display. It is written back only when the user
 * changes something (each finished drag, resize, add or remove), never on load.
 */
function useLayout() {
  const getLayout = useRpc(layoutGetRpc);
  const saveLayout = useRpc(layoutSetRpc);
  const stored = useQuery({ queryKey: ["dashboard", "layout"], queryFn: () => getLayout({}), staleTime: Infinity, retry: 1 });
  const [items, setItems] = useState<Item[] | null>(null);
  const [history, setHistory] = useState<Item[][]>([]);
  useEffect(() => {
    if (stored.data && items === null) setItems(clean(stored.data.layout));
  }, [stored.data, items]);
  const save = useMutation({ mutationFn: (next: Item[]) => saveLayout({ layout: toSaved(next) }) });
  const current = items ?? (stored.isError ? clean(null) : null);
  const update = (next: Item[]) => {
    if (current && sameItems(current, next)) return;
    if (current) setHistory((h) => h.concat([current]).slice(-UNDO_DEPTH));
    setItems(next);
    save.mutate(next);
  };
  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory(history.slice(0, -1));
    setItems(prev);
    save.mutate(prev);
  };
  return { items: current, update, undo, canUndo: history.length > 0 };
}

function useScrollDriver(): [ScrollDriver, boolean] {
  const ref = useRef<ScrollView>(null);
  const viewportRef = useRef<View>(null);
  const offset = useRef(0);
  const contentHeight = useRef(0);
  const [enabled, setEnabled] = useState(true);
  const driver = useMemo<ScrollDriver>(() => ({ ref, viewportRef, offset, contentHeight, setEnabled }), []);
  return [driver, enabled];
}

function Dashboard({ layout: hostLayout, navigation, params }: PluginScreenProps) {
  const p = usePalette();
  const overview = useOverview();
  const { items, update, undo, canUndo } = useLayout();
  const [timeframe, setTimeframe] = useState<Timeframe>(() => initialTimeframe(params));
  const stats = useTimeframe(timeframe);
  const [editing, setEditing] = useState(params?.edit === "1");
  const [selected, setSelected] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [scroll, scrollEnabled] = useScrollDriver();
  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);
  const inner = Math.min(width || 900, MAX_WIDTH);
  const compact = hostLayout.compact || inner < 560;
  const pad = hostLayout.compact ? 16 : 24;
  const todayKey = localDayKey(new Date());

  const period = useMemo(
    () => (stats.data ? { from: stats.data.days[0], to: stats.data.days[stats.data.days.length - 1] } : undefined),
    [stats.data],
  );
  const ctx = useMemo<Omit<BlockContext, "width" | "cols">>(
    () => ({ overview: overview.data, stats: stats.data, timeframe, period, todayKey, navigation, params, compact }),
    [overview.data, stats.data, timeframe, period, todayKey, navigation, params, compact],
  );
  const statsError = stats.error ? String(stats.error) : null;
  const overviewError = overview.error ? String(overview.error) : null;
  const status = useMemo(
    () => ({
      stats: { ready: Boolean(stats.data), error: statsError },
      overview: { ready: Boolean(overview.data), error: overviewError },
    }),
    [stats.data, statsError, overview.data, overviewError],
  );

  const list = items ?? [];
  const hidden = BLOCKS.filter((def) => !list.some((i) => i.id === def.id));
  const add = (id: string) => {
    const def = BLOCK_BY_ID[id];
    if (!def || !items) return;
    update(items.concat([{ id, w: def.defaultW }]));
    setSelected(id);
  };
  const toggleEdit = () => {
    setEditing(!editing);
    setSelected(null);
  };

  // Web: Cmd/Ctrl+Z undoes the last layout change while customizing.
  const undoRef = useRef(undo);
  undoRef.current = undo;
  useEffect(() => {
    if (!editing || Platform.OS !== "web") return;
    return onKeyDown((e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoRef.current();
      }
    });
  }, [editing]);

  const onSelect = useCallback((id: string | null) => setSelected(id), []);

  return (
    <View ref={scroll.viewportRef} style={{ flex: 1, backgroundColor: p.bg }}>
      <ScrollView
        ref={scroll.ref}
        style={{ flex: 1, backgroundColor: p.bg }}
        contentContainerStyle={{ alignItems: "center" }}
        onLayout={onLayout}
        scrollEnabled={scrollEnabled}
        scrollEventThrottle={16}
        onScroll={(e) => (scroll.offset.current = e.nativeEvent.contentOffset.y)}
        onContentSizeChange={(_w, h) => (scroll.contentHeight.current = h)}
      >
        <View
          style={{ width: "100%", maxWidth: MAX_WIDTH, paddingHorizontal: pad, paddingTop: pad, paddingBottom: 40, gap: GAP }}
          // In Customize a press on empty space (not on a block) clears the selection.
          onStartShouldSetResponder={() => editing && selected !== null}
          onResponderRelease={() => setSelected(null)}
        >
          <Header
            timeframe={timeframe}
            onTimeframe={setTimeframe}
            compact={compact}
            editing={editing}
            onEdit={toggleEdit}
            onReset={() => {
              update(clean(null));
              setSelected(null);
            }}
            onUndo={canUndo ? undo : undefined}
          />

          {items === null ? (
            <Placeholder error={null} />
          ) : (
            <Grid
              items={items}
              registry={BLOCK_BY_ID}
              ctx={ctx}
              status={status}
              editing={editing}
              hostCompact={hostLayout.compact}
              scroll={scroll}
              selected={selected}
              onSelect={onSelect}
              onChange={update}
            />
          )}

          {items !== null && (editing || items.length === 0) ? (
            <AddBlocks hidden={hidden} onAdd={add} empty={items.length === 0} onCustomize={editing ? undefined : toggleEdit} />
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function Header({
  timeframe,
  onTimeframe,
  compact,
  editing,
  onEdit,
  onReset,
  onUndo,
}: {
  timeframe: Timeframe;
  onTimeframe: (next: Timeframe) => void;
  compact: boolean;
  editing: boolean;
  onEdit: () => void;
  onReset: () => void;
  onUndo?: () => void;
}) {
  const p = usePalette();
  const title = (
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={{ color: p.fg, fontSize: 16, fontWeight: "500" }}>Dashboard</Text>
      {editing ? (
        <Text style={{ color: p.muted, fontSize: 12 }} numberOfLines={1}>
          {compact ? "Drag the grip to move a block" : "Drag blocks to move them, drag the right edge to resize"}
        </Text>
      ) : null}
    </View>
  );
  const periods = <Segmented options={TIMEFRAMES} value={timeframe} onChange={onTimeframe} stretch={compact} />;
  if (editing) {
    return (
      <View style={{ gap: 8, paddingBottom: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {title}
          {onUndo ? <TextButton icon="Undo2" label={compact ? undefined : "Undo"} onPress={onUndo} /> : null}
          <TextButton icon="RotateCcw" label="Reset" onPress={onReset} />
          <PrimaryButton label="Done" onPress={onEdit} />
        </View>
        {periods}
      </View>
    );
  }
  const gear = <IconButton icon="Settings" label="Customize" onPress={onEdit} size={28} />;
  if (compact) {
    return (
      <View style={{ gap: 8, paddingBottom: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {title}
          {gear}
        </View>
        {periods}
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 4 }}>
      {title}
      {periods}
      {gear}
    </View>
  );
}

function PrimaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={pressStyle(({ hovered, pressed }) => ({
        height: 28,
        paddingHorizontal: 12,
        borderRadius: 6,
        justifyContent: "center",
        backgroundColor: p.fg,
        opacity: pressed ? 0.8 : hovered ? 0.9 : 1,
      }))}
    >
      <Text style={{ color: p.bg, fontSize: 12, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

function IconButton({ icon, label, onPress, size = 24 }: { icon: string; label: string; onPress: () => void; size?: number }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={pressStyle(({ hovered, pressed }) => ({
        width: size,
        height: size,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? p.pressed : hovered ? p.hover : "transparent",
      }))}
    >
      <Icon name={icon} size={size > 24 ? 16 : 14} color={p.muted} />
    </Pressable>
  );
}

const GROUPS: { id: BlockGroup; label: string }[] = [
  { id: "widgets", label: "Widgets" },
  { id: "sections", label: "Sections" },
];

function AddBlocks({
  hidden,
  onAdd,
  empty,
  onCustomize,
}: {
  hidden: BlockDef[];
  onAdd: (id: string) => void;
  empty: boolean;
  onCustomize?: () => void;
}) {
  const p = usePalette();
  return (
    <View style={{ borderRadius: 8, borderWidth: 1, borderStyle: "dashed", borderColor: p.border, padding: 16, gap: 16 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: p.fg, fontSize: 14, fontWeight: "500", flex: 1 }}>
          {empty ? "Your dashboard is empty" : hidden.length ? "Add blocks" : "Every block is on the dashboard"}
        </Text>
        {onCustomize ? <TextButton icon="Settings" label="Customize" onPress={onCustomize} /> : null}
      </View>
      {GROUPS.map((group) => {
        const defs = hidden.filter((d) => d.group === group.id);
        if (!defs.length) return null;
        return (
          <View key={group.id} style={{ gap: 8 }}>
            <Text style={{ color: p.muted, fontSize: 12, fontWeight: "500" }}>{group.label}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {defs.map((def) => (
                <Pressable
                  key={def.id}
                  accessibilityRole="button"
                  accessibilityLabel={"Add " + def.title}
                  onPress={() => onAdd(def.id)}
                  style={pressStyle(({ hovered, pressed }) => ({
                    flexGrow: 1,
                    flexBasis: group.id === "widgets" ? 180 : 260,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: p.border,
                    backgroundColor: pressed ? p.pressed : hovered ? p.hover : p.card,
                  }))}
                >
                  <Icon name={def.icon} size={16} color={p.muted} />
                  <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
                    <Text style={{ color: p.fg, fontSize: 14 }} numberOfLines={1}>
                      {def.title}
                    </Text>
                    <Text style={{ color: p.muted, fontSize: 12 }} numberOfLines={1}>
                      {def.description}
                    </Text>
                  </View>
                  <Text style={[{ color: p.muted, fontSize: 11 }, NUM]}>{def.defaultW + "/" + GRID_COLS}</Text>
                  <Icon name="Plus" size={14} color={p.muted} />
                </Pressable>
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}
