import type { PluginTheme } from "@getpaseo/plugin";

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(color: string): Rgba | null {
  const value = color.trim();
  if (value.charAt(0) === "#") {
    let hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (hex.length !== 6 && hex.length !== 8) return null;
    const n = parseInt(hex.slice(0, 6), 16);
    if (Number.isNaN(n)) return null;
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
  }
  const match = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (match) {
    const parts = match[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(parseFloat);
    if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  return null;
}

export function withAlpha(color: string, alpha: number): string {
  const rgba = parseColor(color);
  if (!rgba) return color;
  return "rgba(" + Math.round(rgba.r) + "," + Math.round(rgba.g) + "," + Math.round(rgba.b) + "," + (rgba.a * alpha).toFixed(3) + ")";
}

function luminance(color: string): number {
  const rgba = parseColor(color);
  if (!rgba) return 0.5;
  return (0.2126 * rgba.r + 0.7152 * rgba.g + 0.0722 * rgba.b) / 255;
}

function saturation(color: string): number {
  const rgba = parseColor(color);
  if (!rgba) return 0;
  const max = Math.max(rgba.r, rgba.g, rgba.b) / 255;
  const min = Math.min(rgba.r, rgba.g, rgba.b) / 255;
  if (max === 0) return 0;
  return (max - min) / max;
}

/** Opaque blend of two colours, t = 0 gives a, t = 1 gives b. Paseo derives tints by mixing. */
export function mix(a: string, b: string, t: number): string {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) return t < 0.5 ? a : b;
  const c = (u: number, v: number) => Math.round(u + (v - u) * t);
  const hex = (n: number) => (n < 16 ? "0" : "") + n.toString(16);
  return "#" + hex(c(x.r, y.r)) + hex(c(x.g, y.g)) + hex(c(x.b, y.b));
}

export interface Palette {
  dark: boolean;
  bg: string;
  card: string;
  hover: string;
  pressed: string;
  border: string;
  fg: string;
  muted: string;
  accent: string;
  accentFg: string;
  /** The hue of the activity charts: the theme accent, or green when the accent is grey. */
  heat: string;
  heatLevels: string[];
  /** Neutral data colour: the long tail of a split, quiet bars. */
  neutral: string;
  line: string;
  success: string;
  warning: string;
  danger: string;
  /** Paseo's sidebar "running" status-dot colour, which the plugin theme does not carry. */
  running: string;
  /** Idle dots and states. */
  idle: string;
}

export function makePalette(theme: PluginTheme): Palette {
  const c = theme.colors;
  const dark = luminance(c.surface0) < 0.5;
  const vivid = saturation(c.accent) > 0.3;
  const base = vivid ? c.accent : dark ? "#35c264" : "#299f51";
  // A dark accent like #20744A disappears on a dark card, so lift it toward white.
  const heat = dark && luminance(base) < 0.45 ? mix(base, "#ffffff", 0.32) : base;
  // Paseo's dark workspace sits on surface1; cards lift a hair above it and keep their border.
  const bg = dark ? c.surface1 : c.surface0;
  const card = dark ? mix(c.surface1, c.foreground, 0.025) : c.surface1;
  const empty = c.surface2;
  return {
    dark,
    bg,
    card,
    hover: c.surface2,
    pressed: c.border,
    border: c.border,
    fg: c.foreground,
    muted: c.foregroundMuted,
    accent: c.accent,
    accentFg: c.accentForeground,
    heat,
    heatLevels: [empty, mix(empty, heat, 0.22), mix(empty, heat, 0.45), mix(empty, heat, 0.7), heat],
    neutral: mix(card, c.foregroundMuted, 0.35),
    line: mix(card, c.foregroundMuted, 0.4),
    success: c.statusSuccess,
    warning: c.statusWarning,
    danger: c.statusDanger,
    running: dark ? "#5caaf6" : "#268ae0",
    idle: mix(card, c.foregroundMuted, 0.45),
  };
}
