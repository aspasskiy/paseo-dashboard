import { Icon } from "@getpaseo/plugin/client/ui";
import { createContext, useContext, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { type Palette } from "./theme";

// Proportions follow Paseo itself: 4px grid, radius 8 for cards,
// 6 for controls, 1px borders and no shadows, text at 14 and 12, weights 400 to 600.

export const PaletteContext = createContext<Palette | null>(null);

export function usePalette(): Palette {
  const palette = useContext(PaletteContext);
  if (!palette) throw new Error("Dashboard palette missing");
  return palette;
}

export const NUM: TextStyle = { fontVariant: ["tabular-nums"] };

export function Card({
  title,
  icon,
  right,
  subtitle,
  children,
  style,
}: {
  title?: string;
  icon?: string;
  right?: ReactNode;
  subtitle?: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const p = usePalette();
  return (
    <View style={[{ backgroundColor: p.card, borderRadius: 8, borderWidth: 1, borderColor: p.border, padding: 16, gap: 12 }, style]}>
      {title ? (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {icon ? <Icon name={icon} size={14} color={p.muted} /> : null}
              <Text style={{ color: p.fg, fontSize: 14, fontWeight: "500" }} numberOfLines={1}>
                {title}
              </Text>
            </View>
            {subtitle ? (
              <Text style={[{ color: p.muted, fontSize: 12, lineHeight: 16 }, NUM]} numberOfLines={2}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function TextButton({ label, icon, onPress }: { label?: string; icon?: string; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? icon}
      onPress={onPress}
      style={pressStyle(({ pressed, hovered }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        height: 24,
        paddingHorizontal: label ? 8 : 4,
        borderRadius: 6,
        backgroundColor: pressed ? p.pressed : hovered ? p.hover : "transparent",
      }))}
    >
      {icon ? <Icon name={icon} size={14} color={p.muted} /> : null}
      {label ? <Text style={{ color: p.muted, fontSize: 12 }}>{label}</Text> : null}
    </Pressable>
  );
}

export function Empty({ icon, text }: { icon: string; text: string }) {
  const p = usePalette();
  return (
    <View style={{ alignItems: "center", paddingVertical: 32, paddingHorizontal: 16, gap: 8 }}>
      <Icon name={icon} size={16} color={p.muted} />
      <Text style={{ color: p.muted, fontSize: 14, textAlign: "center" }}>{text}</Text>
    </View>
  );
}

/** Pressable style with hover: React Native Web reports it, native never does. */
export function pressStyle(fn: (state: { pressed: boolean; hovered: boolean }) => ViewStyle) {
  return (state: PressableStateCallbackType) => fn({ pressed: state.pressed, hovered: Boolean((state as { hovered?: boolean }).hovered) });
}

/** Paseo-style segmented control: a surface2 track, the active segment lifted onto the card. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  stretch,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  stretch?: boolean;
}) {
  const p = usePalette();
  return (
    <View
      accessibilityRole="tablist"
      style={{ flexDirection: "row", alignItems: "center", gap: 2, padding: 2, borderRadius: 6, backgroundColor: p.hover, alignSelf: stretch ? "stretch" : "flex-start" }}
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(o.id)}
            style={pressStyle(({ hovered, pressed }) => ({
              height: 24,
              paddingHorizontal: 10,
              borderRadius: 4,
              justifyContent: "center",
              alignItems: "center",
              flex: stretch ? 1 : undefined,
              backgroundColor: active ? p.card : pressed ? p.pressed : hovered ? p.card : "transparent",
              borderWidth: 1,
              borderColor: active ? p.border : "transparent",
            }))}
          >
            <Text style={{ color: active ? p.fg : p.muted, fontSize: 12, fontWeight: active ? "500" : "400" }} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
