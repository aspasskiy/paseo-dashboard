/**
 * Project icons: the app icon / favicon a project ships, or a monogram tile.
 *
 *   <ProjectIcon path="/Users/me/dev/acme/web" name="acme/web" size={28} />
 *
 * Props
 *   path   absolute project directory ("" or unknown → monogram only, no request)
 *   name   short project name, for the monogram and the accessibility label
 *   size   20 (rows), 28 (list items), 40 (headers); any number works, default 28
 *   style  optional extra style for the outer tile (margins, alignSelf…)
 *
 * Every ProjectIcon rendered in the same tick is fetched with ONE projects.icons call (chunks of
 * 50) and cached in react-query under ["dashboard", "icon", path], so a path is asked for once
 * per session (the server also caches on disk). Tile: radius ≈ size × 0.22, 1px `border`,
 * `hover` behind transparent favicons. Loading or no icon: a monogram in muted text, neutral on
 * purpose (colour only for state) so real icons carry the colour.
 */
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Image, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { projectIconsRpc, type ProjectIcon as ProjectIconData } from "../shared/report";
import { usePalette } from "./kit";

type FetchIcons = (input: { paths: string[] }) => Promise<{ icons: Record<string, ProjectIconData> }>;

// Batching. useRpc returns a new function per component, so the queue is global and the latest
// function wins: all icons on a screen talk to the same host.

interface Waiter {
  resolve: (icon: ProjectIconData) => void;
  reject: (error: unknown) => void;
}

let queue = new Map<string, Waiter[]>();
let queueFetch: FetchIcons | null = null;
let flushScheduled = false;

function flush() {
  flushScheduled = false;
  const pending = queue;
  const fetchIcons = queueFetch!;
  queue = new Map();
  queueFetch = null;
  const paths = [...pending.keys()];
  for (let i = 0; i < paths.length; i += 50) {
    const chunk = paths.slice(i, i + 50);
    fetchIcons({ paths: chunk }).then(
      (result) => {
        for (const path of chunk) {
          const icon = result.icons[path] ?? { uri: null, from: null };
          for (const w of pending.get(path) ?? []) w.resolve(icon);
        }
      },
      (error) => {
        for (const path of chunk) for (const w of pending.get(path) ?? []) w.reject(error);
      },
    );
  }
}

function requestIcon(fetchIcons: FetchIcons, path: string): Promise<ProjectIconData> {
  return new Promise((resolve, reject) => {
    queueFetch = fetchIcons;
    const waiters = queue.get(path);
    if (waiters) waiters.push({ resolve, reject });
    else queue.set(path, [{ resolve, reject }]);
    if (!flushScheduled) {
      flushScheduled = true;
      setTimeout(flush, 0);
    }
  });
}

function useProjectIcon(path: string): string | null {
  const fetchIcons: FetchIcons = useRpc(projectIconsRpc);
  const query = useQuery({
    queryKey: ["dashboard", "icon", path],
    queryFn: () => requestIcon(fetchIcons, path),
    enabled: !!path,
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  return query.data?.uri ?? null;
}

// --- Rendering

function iconRadius(size: number): number {
  return Math.round(size * 0.22);
}

/** "acme-site" → "AS", "MyApp" → "MA", "acme/web" → "A", "notes" → "N". */
function monogram(name: string, max: number): string {
  // For "parent/generic" names the parent is the project.
  const head = (name || "?").replace(/^~\s*/, "").split("/").filter(Boolean)[0] ?? "?";
  const words = head
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s\-_.]+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (!words.length) return "?";
  const first = (w: string) => Array.from(w.replace(/[^\p{L}\p{N}]/gu, ""))[0] ?? "";
  const letters = max >= 2 && words.length >= 2 ? first(words[0]) + first(words[1]) : first(words[0]);
  return letters.toUpperCase() || "?";
}

export function ProjectIcon({ path, name, size = 28, style }: { path: string; name: string; size?: number; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  const uri = useProjectIcon(path);
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = !!uri && failed !== uri;
  const letters = monogram(name, size >= 28 ? 2 : 1);
  return (
    <View
      accessibilityLabel={name}
      style={[
        {
          width: size,
          height: size,
          borderRadius: iconRadius(size),
          borderWidth: 1,
          borderColor: p.border,
          backgroundColor: p.hover,
          overflow: "hidden",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        },
        style,
      ]}
    >
      {showImage ? (
        <Image source={{ uri: uri! }} style={{ width: "100%", height: "100%" }} resizeMode="cover" onError={() => setFailed(uri)} />
      ) : (
        <Text
          numberOfLines={1}
          style={{
            color: p.muted,
            fontSize: Math.max(9, Math.round(size * (letters.length > 1 ? 0.36 : 0.45))),
            lineHeight: Math.round(size * 0.9),
            fontWeight: "600",
            letterSpacing: 0,
          }}
        >
          {letters}
        </Text>
      )}
    </View>
  );
}
