import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";
import type { ReportPeriod, SessionState } from "../../shared/report";
import { pct } from "../format";
import { pressStyle, usePalette } from "../kit";
import type { Palette } from "../theme";
import { TIMEFRAMES } from "../widgets";

// Small pieces of the report card.

export function periodOf(id: ReportPeriod | null | undefined) {
  return TIMEFRAMES.find((x) => x.id === id) ?? TIMEFRAMES[0];
}

export function clamp4(n: number): number {
  return Math.max(0, Math.min(4, Math.round(Number.isFinite(n) ? n : 0)));
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const rest = s % 60;
  return Math.floor(s / 60) + ":" + (rest < 10 ? "0" : "") + rest;
}

/** "Claude · Haiku 5.5" -> "Haiku"; "Codex · GPT-5.4 mini" -> "GPT-5.4 mini". */
export function modelWord(runner: string): string {
  const parts = runner.split(" · ");
  const model = parts[parts.length - 1] || runner;
  return model.replace(/\s+\d[\d.]*$/, "") || model;
}

export const STATE_META: Record<SessionState, { label: string }> = {
  done: { label: "Done" },
  in_progress: { label: "In progress" },
  blocked: { label: "Blocked" },
  abandoned: { label: "Abandoned" },
  no_work: { label: "No work" },
};

export function stateDot(p: Palette, state: SessionState): string {
  if (state === "done") return p.success;
  if (state === "in_progress") return p.running;
  if (state === "blocked") return p.warning;
  return p.idle;
}

/** Importance 0..4 as four short bars; nothing for 0. Critical turns the bars warning. */
export function Importance({ value }: { value: number }) {
  const p = usePalette();
  const n = clamp4(value);
  if (!n) return null;
  const on = n >= 4 ? p.warning : p.muted;
  return (
    <View
      accessibilityLabel={"Importance " + n + " of 4"}
      style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height: 10 }}
    >
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={{ width: 3, height: 4 + i * 2, borderRadius: 1, backgroundColor: i < n ? on : p.border }} />
      ))}
    </View>
  );
}

export function Bar({ value, color, height = 4, track }: { value: number; color: string; height?: number; track?: string }) {
  const p = usePalette();
  const v = Number.isFinite(value) ? value : 0;
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: track ?? p.hover, overflow: "hidden" }}>
      <View style={{ width: pct(v), height, borderRadius: height / 2, backgroundColor: color }} />
    </View>
  );
}

export function PrimaryButton({ label, icon, onPress, disabled }: { label: string; icon?: string; onPress: () => void; disabled?: boolean }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={pressStyle(({ hovered, pressed }) => ({
        height: 32,
        paddingHorizontal: 14,
        borderRadius: 6,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        backgroundColor: p.fg,
        opacity: disabled ? 0.4 : pressed ? 0.8 : hovered ? 0.9 : 1,
      }))}
    >
      {icon ? <Icon name={icon} size={14} color={p.bg} /> : null}
      <Text style={{ color: p.bg, fontSize: 14, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

export function IconButton({ icon, label, onPress, active }: { icon: string; label: string; onPress: () => void; active?: boolean }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: !!active }}
      onPress={onPress}
      style={pressStyle(({ hovered, pressed }) => ({
        width: 28,
        height: 28,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? p.pressed : hovered || active ? p.hover : "transparent",
      }))}
    >
      <Icon name={icon} size={14} color={active ? p.fg : p.muted} />
    </Pressable>
  );
}

export function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={pressStyle(({ hovered, pressed }) => ({
        height: 24,
        paddingHorizontal: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: active ? p.heat : p.border,
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        backgroundColor: pressed ? p.pressed : hovered ? p.hover : "transparent",
      }))}
    >
      {active ? <Icon name="Check" size={12} color={p.heat} /> : null}
      <Text style={{ color: active ? p.fg : p.muted, fontSize: 12 }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A quiet link-like action: muted 12px text with an optional icon, hover fill. */
export function LinkButton({ label, icon, iconRight, onPress, color }: { label: string; icon?: string; iconRight?: string; onPress: () => void; color?: string }) {
  const p = usePalette();
  const c = color ?? p.muted;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={4}
      style={pressStyle(({ hovered, pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        height: 24,
        paddingHorizontal: 6,
        marginHorizontal: -6,
        borderRadius: 6,
        backgroundColor: pressed ? p.pressed : hovered ? p.hover : "transparent",
      }))}
    >
      {icon ? <Icon name={icon} size={12} color={c} /> : null}
      <Text style={{ color: c, fontSize: 12 }} numberOfLines={1}>
        {label}
      </Text>
      {iconRight ? <Icon name={iconRight} size={12} color={c} /> : null}
    </Pressable>
  );
}
