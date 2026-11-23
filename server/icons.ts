import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type { ProjectIcon, projectIconsRpc } from "../shared/report";
import { dataDir, writeJson } from "./paths";

/**
 * Project icons: the app icon / favicon a project already ships, found by probing a few
 * well-known places, shallowly. Pure local file reads and a pure-JS PNG resampler (node:zlib
 * only), so it behaves the same on any OS. Never walks node_modules / build / .git / Pods etc.
 *
 * Detection, best first (scores below):
 *   - Xcode: *.xcassets/AppIcon*.appiconset (Contents.json; dark/tinted variants skipped),
 *     ranked down under Widget / Extension / Watch targets; Icon Composer *.icon/Assets/*.png.
 *   - Expo app.json `expo.icon`, electron-builder package.json `build.icon`.
 *   - Android: {app,android/app}/src/main/res/mipmap-* /ic_launcher(.png|.webp), play store 512.
 *   - Web dirs (root, public, public/icons, static, app, src/app, src, web, assets, resources):
 *     apple-touch-icon, icon-512, android-chrome, logo512, favicon.png, favicon.ico (largest
 *     embedded PNG or 24/32-bit BMP), and the icons listed in *.webmanifest / manifest.json.
 *   - Electron / Tauri: build/icon.png|icns, src-tauri/icons/*, icon.icns (PNG entries).
 *   - Windows (UWP / WinUI) Assets/Square150x150Logo.png, StoreLogo.png, *.ico.
 * Probes run in the project root and in each immediate subfolder (monorepos: front/, apps/x…
 * via the BFS below); a generic folder (web, app, ios…) falls back to its parent.
 * SVG is skipped: the plugin client has no SVG renderer on native.
 * Output: a PNG data URI, at most 128 px, re-encoded; JPEG / WebP only when small enough as is.
 */

type IconsInput = RpcInput<typeof projectIconsRpc>;
type IconsOutput = RpcOutput<typeof projectIconsRpc>;

const MAX_FILE = 2 * 1024 * 1024;
const MAX_URI = 64 * 1024;
const TARGET = 128;
const MAX_DEPTH = 4;
const MAX_DIRS = 700;
const MAX_SUBDIRS = 40;
const NEGATIVE_TTL = 30 * 60_000;
const POSITIVE_RECHECK = 10 * 60_000;
const POSITIVE_TTL = 24 * 3600_000;
const CACHE_VERSION = 2;

const SKIP_DIRS = new Set([
  "node_modules", "build", "dist", "out", "target", "pods", "deriveddata", "carthage", "vendor", "coverage",
  "tmp", "temp", "logs", "bin", "obj", "venv", "env", "__pycache__", "library", "intermediates", "generated",
]);
const SKIP_SUFFIX = [".xcodeproj", ".xcworkspace", ".framework", ".xcframework", ".bundle", ".lproj", ".dSYM", ".playground"];
const BAD_SEGMENT = /^(tests?|__tests__|fixtures?|examples?|demos?|demo-.*|docs?|samples?|mocks?|vendor|third[-_]?party|reviews?|storybook|e2e|screenshots?|store-screenshots|marketing|press|concept|archive|old|backup|design|mockups?|templates?|.*-concept)$/i;
const SECONDARY_TARGET = /(widget|extension|watch|clip|intent|sticker|notification|share|action|keyboard|glyph|tests?|dev|debug|beta|staging)/i;
const GENERIC = new Set(["web", "app", "apps", "api", "server", "client", "src", "frontend", "backend", "ios", "android", "site", "www", "admin", "mobile", "packages", "front", "macos"]);
const WEB_SUBDIRS = ["", "public", "public/icons", "public/images", "public/img", "static", "static/icons", "app", "src/app", "src", "web", "assets", "assets/icon", "assets/images", "resources", "res", "src/assets", "static/img"];
const WEB_NAME = /^(apple-touch-icon|apple-icon|android-chrome|app-?icon|icon|logo|favicon|pwa|maskable[-_]?icon|mstile)([-_.]?(precomposed|maskable|\d+(x\d+)?|512|192))*(@\dx)?\.(png|ico|webp|jpe?g)$/i;

interface Candidate {
  file: string;
  /** Detection base score; the size and path adjust it. */
  base: number;
  /** Pixel size declared by the source (Contents.json, manifest), if any. */
  declared?: number;
}

interface Decoded {
  w: number;
  h: number;
  rgba: Uint8Array;
}

interface CacheEntry {
  uri: string | null;
  from: string | null;
  file: string | null;
  mtimeMs: number;
  at: number;
}

// RPC

export async function getProjectIcons(input: IconsInput): Promise<IconsOutput> {
  await loadDiskCache();
  const icons: Record<string, ProjectIcon> = {};
  const paths = [...new Set(input.paths)].slice(0, 50);
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const path = paths[next++];
      try {
        icons[path] = await iconFor(path);
      } catch {
        icons[path] = { uri: null, from: null };
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  scheduleSave();
  return { icons };
}

const memory = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ProjectIcon>>();

async function iconFor(path: string): Promise<ProjectIcon> {
  const hit = memory.get(path);
  const now = Date.now();
  if (hit) {
    const age = now - hit.at;
    if (!hit.uri && age < NEGATIVE_TTL) return { uri: null, from: null };
    if (hit.uri && age < POSITIVE_RECHECK) return { uri: hit.uri, from: hit.from };
    if (hit.uri && hit.file && age < POSITIVE_TTL) {
      const st = await stat(hit.file).catch(() => null);
      if (st && st.mtimeMs === hit.mtimeMs) return { uri: hit.uri, from: hit.from };
    }
  }
  let job = inflight.get(path);
  if (!job) {
    job = (async () => {
      const found = await findIcon(path).catch(() => null);
      const entry: CacheEntry = found
        ? { uri: found.uri, from: found.from, file: found.file, mtimeMs: found.mtimeMs, at: Date.now() }
        : { uri: null, from: null, file: null, mtimeMs: 0, at: Date.now() };
      memory.set(path, entry);
      dirty = true;
      return { uri: entry.uri, from: entry.from };
    })().finally(() => inflight.delete(path));
    inflight.set(path, job);
  }
  return job;
}

// Disk cache: dataDir()/icons-cache.json, so a daemon restart stays instant.

const CACHE_FILE = () => join(dataDir(), "icons-cache.json");
let diskLoaded: Promise<void> | null = null;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function loadDiskCache(): Promise<void> {
  if (!diskLoaded) {
    diskLoaded = (async () => {
      try {
        const raw = JSON.parse(await readFile(CACHE_FILE(), "utf8"));
        if (raw?.version !== CACHE_VERSION || typeof raw.entries !== "object") return;
        for (const [key, value] of Object.entries(raw.entries as Record<string, CacheEntry>)) {
          if (!memory.has(key) && value && typeof value.at === "number") memory.set(key, value);
        }
      } catch {
        // no cache yet
      }
    })();
  }
  return diskLoaded;
}

function scheduleSave() {
  if (!dirty || saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      await writeJson(CACHE_FILE(), { version: CACHE_VERSION, entries: Object.fromEntries(memory) });
    } catch {
      // cache is best effort
    }
  }, 500);
}

// Search

interface Found {
  uri: string;
  from: string;
  file: string;
  mtimeMs: number;
}

/** Folders never scanned: the filesystem root, the home folder and anything above it. */
function isRefused(path: string): boolean {
  const home = homedir();
  if (path === sep || path === home) return true;
  if (home.startsWith(path + sep)) return true;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length < 2 || (process.platform === "win32" && /^[a-z]:\\?$/i.test(path));
}

async function findIcon(path: string): Promise<Found | null> {
  if (!path || !isAbsolute(path)) return null;
  let root: string;
  try {
    root = await realpath(resolve(path));
  } catch {
    return null;
  }
  if (isRefused(root)) return null;
  const st = await stat(root).catch(() => null);
  if (!st?.isDirectory()) return null;
  const found = await searchRoot(root, root);
  if (found) return found;
  // A generic subfolder ("acme/web", "app/ios"): the parent project's icon.
  if (GENERIC.has(basename(root).toLowerCase())) {
    const parent = dirname(root);
    if (!isRefused(parent)) return searchRoot(parent, root);
  }
  return null;
}

async function searchRoot(root: string, label: string): Promise<Found | null> {
  const candidates = await collect(root);
  const scored: { c: Candidate; score: number; data: Buffer; mtimeMs: number; img: Decoded | null; mime: string }[] = [];
  // Read the most promising ones first (by base score), at most 24 files.
  candidates.sort((a, b) => b.base - a.base);
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.file) || seen.size >= 24) continue;
    seen.add(c.file);
    const loaded = await loadImage(c.file, root);
    if (!loaded) continue;
    const { w, h } = loaded;
    if (!w || !h || Math.abs(w / h - 1) > 0.2) continue; // wordmarks, banners
    scored.push({ c, score: scoreOf(c, root, Math.min(w, h)), data: loaded.data, mtimeMs: loaded.mtimeMs, img: loaded.img, mime: loaded.mime });
  }
  scored.sort((a, b) => b.score - a.score || (b.img?.w ?? 0) - (a.img?.w ?? 0));
  for (const s of scored) {
    const uri = toDataUri(s.img, s.data, s.mime);
    if (uri) {
      const rel = relative(label, s.c.file);
      return { uri, from: rel.startsWith("..") ? relative(dirname(label), s.c.file) : rel, file: s.c.file, mtimeMs: s.mtimeMs };
    }
  }
  return null;
}

function scoreOf(c: Candidate, root: string, size: number): number {
  let score = c.base;
  if (size >= 128) score += 20;
  else if (size >= 96) score += 12;
  else if (size >= 64) score += 5;
  else if (size >= 48) score += 0;
  else if (size >= 32) score -= 15;
  else score -= 30;
  const segments = relative(root, dirname(c.file)).split(sep).filter(Boolean);
  // Only the folders that are not part of a standard icon location count as depth.
  const structural = segments.filter((s) => !/\.(xcassets|appiconset|icon)$/i.test(s) && !/^(public|static|icons?|src|main|res|mipmap-.*|app|assets|resources|images|img|web|build|src-tauri)$/i.test(s));
  score -= structural.length * 4;
  if (segments.some((s) => BAD_SEGMENT.test(s))) score -= 45;
  // In an appiconset the variants are already filtered by Contents.json ("Icon-light.png" is the default one).
  const name = basename(c.file).toLowerCase();
  if (!/\.appiconset$/i.test(dirname(c.file)) && /dark|light|mono|tinted|white|black/.test(name)) score -= 6;
  return score;
}

/**
 * Every path here is built by joining names onto the realpath'd project root, so it equals its
 * own realpath unless some component is a symlink: then it is refused (never followed).
 */
async function noSymlink(path: string): Promise<boolean> {
  try {
    const real = await realpath(path);
    return process.platform === "darwin" || process.platform === "win32" ? real.toLowerCase() === path.toLowerCase() : real === path;
  } catch {
    return false;
  }
}

async function readdirSafe(dir: string): Promise<Dirent[]> {
  try {
    if (!(await noSymlink(dir))) return [];
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function skipDir(name: string): boolean {
  if (name.startsWith(".") || name.startsWith("_")) return true;
  const lower = name.toLowerCase();
  if (SKIP_DIRS.has(lower)) return true;
  return SKIP_SUFFIX.some((s) => lower.endsWith(s.toLowerCase()));
}

async function collect(root: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  // Fixed probes in the root and in each immediate subfolder (monorepos, front/, frontend/).
  await probeFixed(root, out, 0);
  // BFS for Xcode asset catalogs, Icon Composer files and UWP Assets folders.
  let queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let visited = 0;
  let subdirsProbed = 0;
  while (queue.length && visited < MAX_DIRS) {
    const nextQueue: typeof queue = [];
    for (const { dir, depth } of queue) {
      if (visited >= MAX_DIRS) break;
      visited++;
      const entries = await readdirSafe(dir);
      for (const e of entries) {
        if (!e.isDirectory() || e.isSymbolicLink()) continue;
        const full = join(dir, e.name);
        const lower = e.name.toLowerCase();
        if (lower.endsWith(".xcassets")) {
          await probeXcassets(full, out, root);
          continue;
        }
        if (lower.endsWith(".icon")) {
          await probeIconComposer(full, out);
          continue;
        }
        if (skipDir(e.name)) continue;
        if (e.name === "Assets") await probeUwpAssets(full, out);
        if (depth === 0 && subdirsProbed < MAX_SUBDIRS) {
          subdirsProbed++;
          await probeFixed(full, out, 1);
        }
        // Monorepos: apps/<name>, packages/<name>
        if (depth === 1 && /^(apps|packages)$/i.test(basename(dir)) && subdirsProbed < MAX_SUBDIRS) {
          subdirsProbed++;
          await probeFixed(full, out, 2);
        }
        if (depth + 1 < MAX_DEPTH) nextQueue.push({ dir: full, depth: depth + 1 });
      }
    }
    queue = nextQueue;
  }
  return out;
}

async function isFile(path: string): Promise<boolean> {
  if (!(await noSymlink(path))) return false;
  const st = await stat(path).catch(() => null);
  return !!st?.isFile();
}

async function readJson(path: string): Promise<any> {
  try {
    if (!(await noSymlink(path))) return null;
    const st = await stat(path);
    if (!st.isFile() || st.size > 512 * 1024) return null;
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Is `child` inside `dir` (no "..", no absolute escape)? */
function inside(dir: string, child: string): boolean {
  const rel = relative(dir, child);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

async function probeFixed(base: string, out: Candidate[], level: number): Promise<void> {
  const penalty = level * 6;
  // Expo / React Native: app.json → expo.icon
  const appJson = await readJson(join(base, "app.json"));
  const expoIcon = appJson?.expo?.icon ?? appJson?.icon;
  if (typeof expoIcon === "string" && !expoIcon.endsWith(".svg")) {
    const file = resolve(base, expoIcon);
    if (inside(base, file)) out.push({ file, base: 92 - penalty });
  }
  // electron-builder: package.json → build.icon (a file, or a folder of sizes)
  const pkg = await readJson(join(base, "package.json"));
  const builderIcon = pkg?.build?.icon;
  if (typeof builderIcon === "string") {
    const file = resolve(base, builderIcon);
    if (inside(base, file)) {
      if (await isFile(file)) out.push({ file, base: 86 - penalty });
      else await probeNamed(file, /^(icon|\d+x\d+)(@2x)?\.(png|icns|ico)$/i, 86 - penalty, out);
    }
  }
  // Electron / Tauri
  await probeNamed(join(base, "build"), /^icon\.(png|icns|ico)$/i, 85 - penalty, out);
  await probeNamed(join(base, "build", "icons"), /^(icon|512x512|256x256)\.png$/i, 85 - penalty, out);
  await probeNamed(join(base, "src-tauri", "icons"), /^(128x128@2x|icon|128x128|Square310x310Logo)\.(png|icns)$/i, 86 - penalty, out);
  // Android
  for (const app of ["app", "android/app"]) {
    const main = join(base, app, "src", "main");
    await probeNamed(main, /^(ic_launcher-playstore|play_store_512)\.png$/i, 95 - penalty, out);
    const res = join(main, "res");
    for (const density of ["xxxhdpi", "xxhdpi", "xhdpi", "hdpi", "mdpi"]) {
      const dir = join(res, "mipmap-" + density);
      for (const e of await readdirSafe(dir)) {
        if (!e.isFile()) continue;
        const m = /^ic_launcher(_round|_foreground|_background|_monochrome)?\.(png|webp)$/i.exec(e.name);
        if (!m) continue;
        const kind = (m[1] || "").toLowerCase();
        if (kind === "_background" || kind === "_monochrome") continue;
        const base0 = kind === "" ? 90 : kind === "_round" ? 86 : 45;
        out.push({ file: join(dir, e.name), base: base0 - penalty - (m[2].toLowerCase() === "webp" ? 2 : 0) });
      }
    }
  }
  // Web
  for (const sub of WEB_SUBDIRS) {
    const dir = sub ? join(base, sub) : base;
    const entries = await readdirSafe(dir);
    if (!entries.length) continue;
    for (const e of entries) {
      if (!e.isFile() || e.isSymbolicLink()) continue;
      const name = e.name;
      const lower = name.toLowerCase();
      if (/^(site\.webmanifest|manifest\.webmanifest|manifest\.json)$/.test(lower)) {
        await probeManifest(join(dir, name), dir, base, out, penalty);
        continue;
      }
      if (lower.endsWith(".icns") && /icon/i.test(lower)) {
        out.push({ file: join(dir, name), base: 78 - penalty });
        continue;
      }
      if (!WEB_NAME.test(name)) continue;
      let score: number;
      if (lower.startsWith("apple-touch-icon") || lower.startsWith("apple-icon")) score = 88;
      else if (lower.startsWith("android-chrome") || /^(app-?icon|icon|pwa)/.test(lower)) score = lower.includes("maskable") ? 72 : 80;
      else if (/^logo\d+\.png$/.test(lower)) score = 78; // create-react-app logo192/logo512
      else if (lower.startsWith("favicon")) score = lower.endsWith(".ico") ? 58 : 62;
      else if (lower.startsWith("logo")) score = 45;
      else score = 50;
      // public/images, assets/images: lots of unrelated pictures, trust only explicit icon names
      if (/images|img/.test(sub) && score < 80) continue;
      out.push({ file: join(dir, name), base: score - penalty });
    }
  }
}

async function probeNamed(dir: string, pattern: RegExp, score: number, out: Candidate[]) {
  for (const e of await readdirSafe(dir)) {
    if (e.isFile() && !e.isSymbolicLink() && pattern.test(e.name)) out.push({ file: join(dir, e.name), base: score });
  }
}

async function probeManifest(file: string, dir: string, base: string, out: Candidate[], penalty: number) {
  const json = await readJson(file);
  if (!json || !Array.isArray(json.icons)) return;
  for (const icon of json.icons) {
    if (!icon || typeof icon.src !== "string" || /^(https?:|data:)/.test(icon.src) || icon.src.endsWith(".svg")) continue;
    const src = icon.src.split(/[?#]/)[0];
    // "/icons/x.png" is relative to the site root = the folder the manifest is served from.
    const target = src.startsWith("/") ? join(dir, src) : resolve(dirname(file), src);
    if (!inside(base, target)) continue;
    const sizes = typeof icon.sizes === "string" ? Math.max(0, ...icon.sizes.split(/\s+/).map((s: string) => parseInt(s, 10) || 0)) : 0;
    const maskable = typeof icon.purpose === "string" && icon.purpose.includes("maskable") && !icon.purpose.includes("any");
    out.push({ file: target, base: (maskable ? 72 : 80) - penalty, declared: sizes });
  }
}

async function probeXcassets(dir: string, out: Candidate[], root: string) {
  for (const e of await readdirSafe(dir)) {
    if (!e.isDirectory() || e.isSymbolicLink() || !e.name.toLowerCase().endsWith(".appiconset")) continue;
    const set = join(dir, e.name);
    const secondary = SECONDARY_TARGET.test(e.name.replace(/\.appiconset$/i, "")) || SECONDARY_TARGET.test(relative(root, dir));
    let base = e.name === "AppIcon.appiconset" ? 100 : 94;
    if (secondary) base -= 25;
    const contents = await readJson(join(set, "Contents.json"));
    const images: any[] = Array.isArray(contents?.images) ? contents.images : [];
    let added = 0;
    for (const img of images) {
      if (!img || typeof img.filename !== "string" || img.appearances) continue;
      const size = parseFloat(String(img.size || "0")) * (parseFloat(String(img.scale || "1")) || 1);
      const mac = img.idiom === "mac" || img.platform === "macos";
      out.push({ file: join(set, img.filename), base: base - (mac ? 8 : 0), declared: size || undefined });
      added++;
    }
    if (!added) await probeNamed(set, /\.png$/i, base - 4, out);
  }
}

async function probeIconComposer(dir: string, out: Candidate[]) {
  // Composited from icon.json (fill + PNG layers) at load time, see composeIconFile.
  if (await isFile(join(dir, "icon.json"))) out.push({ file: join(dir, "icon.json"), base: 96 });
}

async function probeUwpAssets(dir: string, out: Candidate[]) {
  for (const e of await readdirSafe(dir)) {
    if (!e.isFile() || e.isSymbolicLink()) continue;
    const name = e.name;
    if (/^Square150x150Logo(\.scale-\d+)?\.png$/i.test(name)) out.push({ file: join(dir, name), base: 75 });
    else if (/^StoreLogo(\.scale-\d+)?\.png$/i.test(name)) out.push({ file: join(dir, name), base: 70 });
    else if (/^Square44x44Logo(\.scale-\d+)?\.png$/i.test(name)) out.push({ file: join(dir, name), base: 66 });
    else if (/\.ico$/i.test(name) && !/light|dark/i.test(name)) out.push({ file: join(dir, name), base: 64 });
    else if (/\.ico$/i.test(name)) out.push({ file: join(dir, name), base: 60 });
  }
}

// Loading and converting

interface Loaded {
  w: number;
  h: number;
  data: Buffer;
  img: Decoded | null;
  mime: string;
  mtimeMs: number;
}

async function loadImage(file: string, root: string): Promise<Loaded | null> {
  let st;
  try {
    // Never follow a symlink out of the project.
    const real = await realpath(file);
    if (!inside(root, real)) return null;
    file = real;
    st = await stat(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_FILE || st.size < 16) return null;
  if (basename(file) === "icon.json" && dirname(file).toLowerCase().endsWith(".icon")) {
    const img = await composeIconFile(dirname(file));
    return img ? { w: img.w, h: img.h, data: Buffer.alloc(0), img, mime: "image/png", mtimeMs: st.mtimeMs } : null;
  }
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    return null;
  }
  const ext = extname(file).toLowerCase();
  const mtimeMs = st.mtimeMs;
  if (isPng(data)) {
    const img = decodePng(data);
    const dims = pngSize(data);
    if (!dims) return null;
    return { ...dims, data, img, mime: "image/png", mtimeMs };
  }
  if (ext === ".ico" || (data[0] === 0 && data[1] === 0 && data[2] === 1 && data[3] === 0)) {
    const img = decodeIco(data);
    return img ? { w: img.w, h: img.h, data, img, mime: "image/png", mtimeMs } : null;
  }
  if (data.toString("latin1", 0, 4) === "icns") {
    const png = largestIcnsPng(data);
    if (!png) return null;
    const img = decodePng(png);
    const dims = pngSize(png);
    return dims ? { ...dims, data: png, img, mime: "image/png", mtimeMs } : null;
  }
  if (data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") {
    const dims = webpSize(data);
    return dims ? { ...dims, data, img: null, mime: "image/webp", mtimeMs } : null;
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    const dims = jpegSize(data);
    if (!dims) return null;
    // Small enough to send as is; otherwise the DC-only decode (1/8 scale, exact block averages).
    const img = data.length * 4 / 3 + 32 <= MAX_URI ? null : decodeJpegDc(data);
    return { ...dims, data, img, mime: "image/jpeg", mtimeMs };
  }
  return null;
}

function toDataUri(img: Decoded | null, original: Buffer, mime: string): string | null {
  if (img) {
    for (const target of [TARGET, 96, 64]) {
      const scaled = Math.max(img.w, img.h) > target ? resize(img, target) : img;
      const uri = "data:image/png;base64," + encodePng(scaled).toString("base64");
      if (uri.length <= MAX_URI) return uri;
    }
    return null;
  }
  // A format we cannot decode (JPEG, WebP, interlaced PNG): only when small enough as is.
  const uri = "data:" + mime + ";base64," + original.toString("base64");
  return uri.length <= MAX_URI ? uri : null;
}

// Icon Composer (.icon): icon.json = a fill plus groups of image layers (groups[0] on top),
// on a 1024-pt canvas. Flattened here without the glass / shadow effects, light appearance.

function parseIconColor(value: unknown): [number, number, number, number] | null {
  if (typeof value !== "string") return null;
  const m = /^(?:[a-z0-9-]+:)?\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?/i.exec(value);
  if (!m) return null;
  const c = (v: string) => Math.max(0, Math.min(255, Math.round(parseFloat(v) * 255)));
  return [c(m[1]), c(m[2]), c(m[3]), m[4] === undefined ? 255 : c(m[4])];
}

function hiddenInLight(node: any): boolean {
  const list = node?.["hidden-specializations"];
  if (Array.isArray(list) && list.some((s: any) => (s?.appearance === undefined || s.appearance === "light") && s.value === true)) return true;
  return node?.hidden === true;
}

async function composeIconFile(dir: string): Promise<Decoded | null> {
  const json = await readJson(join(dir, "icon.json"));
  if (!json || !Array.isArray(json.groups)) return null;
  const size = TARGET;
  const rgba = new Uint8Array(size * size * 4);
  // Fill: solid, linear gradient (top → bottom) or automatic gradient; none = white.
  const fill = json.fill ?? json["fill-specializations"]?.[0]?.value;
  let top: [number, number, number, number] = [255, 255, 255, 255];
  let bottom = top;
  if (fill && typeof fill === "object") {
    if (Array.isArray(fill["linear-gradient"])) {
      top = parseIconColor(fill["linear-gradient"][0]) ?? top;
      bottom = parseIconColor(fill["linear-gradient"][1]) ?? top;
    } else if (fill.solid) top = bottom = parseIconColor(fill.solid) ?? top;
    else if (fill["automatic-gradient"]) {
      top = parseIconColor(fill["automatic-gradient"]) ?? top;
      bottom = [Math.round(top[0] * 0.85), Math.round(top[1] * 0.85), Math.round(top[2] * 0.85), 255];
    }
  }
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(top[c] + (bottom[c] - top[c]) * t);
      rgba[o + 3] = 255;
    }
  }
  let drawn = 0;
  for (const group of [...json.groups].reverse()) {
    if (!group || hiddenInLight(group) || !Array.isArray(group.layers)) continue;
    for (const layer of [...group.layers].reverse()) {
      if (!layer || hiddenInLight(layer) || typeof layer["image-name"] !== "string" || !/\.png$/i.test(layer["image-name"])) continue;
      const file = join(dir, "Assets", basename(layer["image-name"]));
      const real = await realpath(file).catch(() => "");
      if (!inside(dir, real)) continue;
      const st = await stat(file).catch(() => null);
      if (!st?.isFile() || st.size > MAX_FILE) continue;
      const img = decodePng(await readFile(file));
      if (!img) continue;
      const scale = (Number(group.position?.scale) || 1) * (Number(layer.position?.scale) || 1);
      const tr = layer.position?.["translation-in-points"] ?? [0, 0];
      const gtr = group.position?.["translation-in-points"] ?? [0, 0];
      // Layer images are in pixels at 1x of the 1024-pt canvas.
      const k = (size / 1024) * scale;
      const target = Math.max(1, Math.round(Math.max(img.w, img.h) * k));
      const small = target < Math.max(img.w, img.h) ? resize(img, target) : img;
      const ox = Math.round(size / 2 - small.w / 2 + ((Number(tr[0]) || 0) + (Number(gtr[0]) || 0)) * (size / 1024));
      const oy = Math.round(size / 2 - small.h / 2 + ((Number(tr[1]) || 0) + (Number(gtr[1]) || 0)) * (size / 1024));
      const opacity = typeof layer.opacity === "number" ? layer.opacity : 1;
      for (let y = 0; y < small.h; y++) {
        const Y = oy + y;
        if (Y < 0 || Y >= size) continue;
        for (let x = 0; x < small.w; x++) {
          const X = ox + x;
          if (X < 0 || X >= size) continue;
          const i = (y * small.w + x) * 4;
          const a = (small.rgba[i + 3] / 255) * opacity;
          if (a <= 0) continue;
          const o = (Y * size + X) * 4;
          for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(small.rgba[i + c] * a + rgba[o + c] * (1 - a));
        }
      }
      drawn++;
    }
  }
  return drawn ? { w: size, h: size, rgba } : null;
}

// PNG decode / encode (non-interlaced; 1–16 bit; grey, RGB, palette, grey+alpha, RGBA)

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(data: Buffer): boolean {
  return data.length > 24 && data.subarray(0, 8).equals(PNG_MAGIC);
}

function pngSize(data: Buffer): { w: number; h: number } | null {
  if (!isPng(data) || data.toString("latin1", 12, 16) !== "IHDR") return null;
  return { w: data.readUInt32BE(16), h: data.readUInt32BE(20) };
}

function decodePng(data: Buffer): Decoded | null {
  try {
    if (!isPng(data)) return null;
    let pos = 8;
    let w = 0, h = 0, depth = 0, color = 0, interlace = 0;
    let palette: Buffer | null = null;
    let trns: Buffer | null = null;
    const idat: Buffer[] = [];
    while (pos + 8 <= data.length) {
      const len = data.readUInt32BE(pos);
      const type = data.toString("latin1", pos + 4, pos + 8);
      const body = data.subarray(pos + 8, pos + 8 + len);
      if (type === "IHDR") {
        w = body.readUInt32BE(0);
        h = body.readUInt32BE(4);
        depth = body[8];
        color = body[9];
        interlace = body[12];
      } else if (type === "PLTE") palette = body;
      else if (type === "tRNS") trns = body;
      else if (type === "IDAT") idat.push(body);
      else if (type === "IEND") break;
      else if (type === "CgBI") return null; // Apple-optimised PNG, not standard zlib
      pos += 12 + len;
    }
    if (!w || !h || interlace !== 0 || w * h > 4096 * 4096) return null;
    const channels = color === 0 ? 1 : color === 2 ? 3 : color === 3 ? 1 : color === 4 ? 2 : color === 6 ? 4 : 0;
    if (!channels || ![1, 2, 4, 8, 16].includes(depth)) return null;
    const raw = inflateSync(Buffer.concat(idat));
    const bitsPP = channels * depth;
    const bpp = Math.max(1, bitsPP >> 3);
    const stride = Math.ceil((w * bitsPP) / 8);
    if (raw.length < (stride + 1) * h) return null;
    const lines = Buffer.alloc(stride * h);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
      const filter = raw[y * (stride + 1)];
      const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      const line = lines.subarray(y * stride, (y + 1) * stride);
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? line[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let v = src[x];
        switch (filter) {
          case 0: break;
          case 1: v += a; break;
          case 2: v += b; break;
          case 3: v += (a + b) >> 1; break;
          case 4: {
            const p = a + b - c;
            const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            break;
          }
          default: return null;
        }
        line[x] = v & 255;
      }
      prev = line;
    }
    const rgba = new Uint8Array(w * h * 4);
    const maxVal = (1 << Math.min(depth, 8)) - 1;
    const sample = (line: Buffer, i: number): number => {
      if (depth === 8) return line[i];
      if (depth === 16) return line[i * 2];
      const bitPos = i * depth;
      return (line[bitPos >> 3] >> (8 - depth - (bitPos & 7))) & maxVal;
    };
    const sample16 = (line: Buffer, i: number): number => (depth === 16 ? line.readUInt16BE(i * 2) : sample(line, i));
    const scale = depth < 8 ? 255 / maxVal : 1;
    for (let y = 0; y < h; y++) {
      const line = lines.subarray(y * stride, (y + 1) * stride);
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const i = x * channels;
        if (color === 3) {
          const idx = sample(line, i);
          if (!palette || idx * 3 + 2 >= palette.length) continue;
          rgba[o] = palette[idx * 3];
          rgba[o + 1] = palette[idx * 3 + 1];
          rgba[o + 2] = palette[idx * 3 + 2];
          rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
        } else if (color === 0 || color === 4) {
          const g = Math.round(sample(line, i) * scale);
          rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
          let alpha = color === 4 ? sample(line, i + 1) : 255;
          if (color === 0 && trns && trns.length >= 2 && sample16(line, i) === trns.readUInt16BE(0)) alpha = 0;
          rgba[o + 3] = alpha;
        } else {
          rgba[o] = sample(line, i);
          rgba[o + 1] = sample(line, i + 1);
          rgba[o + 2] = sample(line, i + 2);
          let alpha = color === 6 ? sample(line, i + 3) : 255;
          if (color === 2 && trns && trns.length >= 6 && sample16(line, i) === trns.readUInt16BE(0) && sample16(line, i + 1) === trns.readUInt16BE(2) && sample16(line, i + 2) === trns.readUInt16BE(4)) alpha = 0;
          rgba[o + 3] = alpha;
        }
      }
    }
    return { w, h, rgba };
  } catch {
    return null;
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

function encodePng(img: Decoded): Buffer {
  const { w, h, rgba } = img;
  const stride = w * 4;
  const out = Buffer.alloc((stride + 1) * h);
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < h; y++) {
    // Pick the filter with the smallest sum of absolute values per row (the libpng heuristic).
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const dst = cand[f];
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const i = y * stride + x;
        const v = rgba[i];
        const a = x >= 4 ? rgba[i - 4] : 0;
        const b = y > 0 ? rgba[i - stride] : 0;
        const c = x >= 4 && y > 0 ? rgba[i - stride - 4] : 0;
        let r: number;
        if (f === 0) r = v;
        else if (f === 1) r = v - a;
        else if (f === 2) r = v - b;
        else if (f === 3) r = v - ((a + b) >> 1);
        else {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          r = v - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        r &= 255;
        dst[x] = r;
        sum += r < 128 ? r : 256 - r;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    out[y * (stride + 1)] = best;
    cand[best].copy(out, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([PNG_MAGIC, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(out, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Area-average downscale (premultiplied alpha), longest side → `target`. */
function resize(img: Decoded, target: number): Decoded {
  const { w, h, rgba } = img;
  const k = target / Math.max(w, h);
  const W = Math.max(1, Math.round(w * k));
  const H = Math.max(1, Math.round(h * k));
  // Horizontal pass into floats (premultiplied), then vertical.
  const tmp = new Float32Array(W * h * 4);
  const sx = w / W;
  for (let y = 0; y < h; y++) {
    for (let X = 0; X < W; X++) {
      const x0 = X * sx, x1 = x0 + sx;
      let r = 0, g = 0, b = 0, a = 0;
      for (let x = Math.floor(x0); x < Math.ceil(x1) && x < w; x++) {
        const wt = Math.min(x + 1, x1) - Math.max(x, x0);
        const i = (y * w + x) * 4;
        const al = (rgba[i + 3] / 255) * wt;
        r += rgba[i] * al;
        g += rgba[i + 1] * al;
        b += rgba[i + 2] * al;
        a += al;
      }
      const o = (y * W + X) * 4;
      tmp[o] = r / sx;
      tmp[o + 1] = g / sx;
      tmp[o + 2] = b / sx;
      tmp[o + 3] = a / sx;
    }
  }
  const out = new Uint8Array(W * H * 4);
  const sy = h / H;
  for (let Y = 0; Y < H; Y++) {
    const y0 = Y * sy, y1 = y0 + sy;
    for (let X = 0; X < W; X++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1) && y < h; y++) {
        const wt = Math.min(y + 1, y1) - Math.max(y, y0);
        const i = (y * W + X) * 4;
        r += tmp[i] * wt;
        g += tmp[i + 1] * wt;
        b += tmp[i + 2] * wt;
        a += tmp[i + 3] * wt;
      }
      const o = (Y * W + X) * 4;
      const alpha = a / sy;
      if (alpha > 0) {
        out[o] = Math.min(255, Math.round(r / sy / alpha));
        out[o + 1] = Math.min(255, Math.round(g / sy / alpha));
        out[o + 2] = Math.min(255, Math.round(b / sy / alpha));
      }
      out[o + 3] = Math.min(255, Math.round(alpha * 255));
    }
  }
  return { w: W, h: H, rgba: out };
}

// ICO / ICNS / WebP / JPEG

function decodeIco(data: Buffer): Decoded | null {
  if (data.length < 6 || data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) return null;
  const count = data.readUInt16LE(4);
  const entries: { w: number; bpp: number; size: number; offset: number }[] = [];
  for (let i = 0; i < count && 6 + i * 16 + 16 <= data.length; i++) {
    const p = 6 + i * 16;
    entries.push({ w: data[p] || 256, bpp: data.readUInt16LE(p + 6), size: data.readUInt32LE(p + 8), offset: data.readUInt32LE(p + 12) });
  }
  entries.sort((a, b) => b.w - a.w || b.bpp - a.bpp);
  for (const e of entries) {
    if (e.offset + e.size > data.length) continue;
    const body = data.subarray(e.offset, e.offset + e.size);
    const img = isPng(body) ? decodePng(body) : decodeIcoBmp(body);
    if (img) return img;
  }
  return null;
}

/** A 24- or 32-bit BMP inside an ICO (BITMAPINFOHEADER, bottom-up, AND mask after). */
function decodeIcoBmp(body: Buffer): Decoded | null {
  if (body.length < 40 || body.readUInt32LE(0) < 40) return null;
  const headerSize = body.readUInt32LE(0);
  const w = body.readInt32LE(4);
  const h = Math.abs(body.readInt32LE(8)) >> 1;
  const bpp = body.readUInt16LE(14);
  if (w <= 0 || h <= 0 || w > 512 || (bpp !== 32 && bpp !== 24) || body.readUInt32LE(16) !== 0) return null;
  const stride = Math.ceil((w * bpp) / 32) * 4;
  const maskStride = Math.ceil(w / 32) * 4;
  const pixels = headerSize;
  const mask = pixels + stride * h;
  if (mask > body.length) return null;
  const rgba = new Uint8Array(w * h * 4);
  let anyAlpha = false;
  for (let y = 0; y < h; y++) {
    const row = pixels + (h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const i = row + x * (bpp >> 3);
      const o = (y * w + x) * 4;
      rgba[o] = body[i + 2];
      rgba[o + 1] = body[i + 1];
      rgba[o + 2] = body[i];
      rgba[o + 3] = bpp === 32 ? body[i + 3] : 255;
      if (bpp === 32 && body[i + 3]) anyAlpha = true;
    }
  }
  if ((bpp === 24 || !anyAlpha) && mask + maskStride * h <= body.length) {
    for (let y = 0; y < h; y++) {
      const row = mask + (h - 1 - y) * maskStride;
      for (let x = 0; x < w; x++) {
        const transparent = (body[row + (x >> 3)] >> (7 - (x & 7))) & 1;
        rgba[(y * w + x) * 4 + 3] = transparent ? 0 : 255;
      }
    }
  }
  return { w, h, rgba };
}

function largestIcnsPng(data: Buffer): Buffer | null {
  let pos = 8;
  let best: Buffer | null = null;
  let bestW = 0;
  while (pos + 8 <= data.length) {
    const len = data.readUInt32BE(pos + 4);
    if (len < 8) break;
    const body = data.subarray(pos + 8, Math.min(data.length, pos + len));
    if (isPng(body)) {
      const w = body.readUInt32BE(16);
      // Prefer the smallest PNG that still covers the target: decoding 1024² is wasted work.
      const better = !best || (w >= TARGET && (bestW < TARGET || w < bestW)) || (bestW < TARGET && w > bestW);
      if (better) {
        best = body;
        bestW = w;
      }
    }
    pos += len;
  }
  return best;
}

function webpSize(data: Buffer): { w: number; h: number } | null {
  const kind = data.toString("latin1", 12, 16);
  if (kind === "VP8X" && data.length >= 30) return { w: 1 + data.readUIntLE(24, 3), h: 1 + data.readUIntLE(27, 3) };
  if (kind === "VP8 " && data.length >= 30) return { w: data.readUInt16LE(26) & 0x3fff, h: data.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8L" && data.length >= 25) {
    const b = data.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function jpegSize(data: Buffer): { w: number; h: number } | null {
  let pos = 2;
  while (pos + 9 < data.length) {
    if (data[pos] !== 0xff) return null;
    const marker = data[pos + 1];
    const len = data.readUInt16BE(pos + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: data.readUInt16BE(pos + 5), w: data.readUInt16BE(pos + 7) };
    }
    pos += 2 + len;
  }
  return null;
}

/**
 * Baseline JPEG at 1/8 scale: only the DC coefficient of each 8×8 block is kept (it is the
 * block's mean), so there is no IDCT; AC coefficients are Huffman-decoded and dropped. A
 * 1024² app icon becomes 128² directly. Progressive / arithmetic / CMYK JPEGs → null.
 */
function decodeJpegDc(data: Buffer): Decoded | null {
  try {
    const q: number[][] = [];
    const dcTables: (Huff | undefined)[] = [];
    const acTables: (Huff | undefined)[] = [];
    let frame: { w: number; h: number; comps: { id: number; h: number; v: number; tq: number }[] } | null = null;
    let restart = 0;
    let pos = 2;
    while (pos + 4 <= data.length) {
      if (data[pos] !== 0xff) return null;
      const marker = data[pos + 1];
      if (marker === 0xff) {
        pos++;
        continue;
      }
      const len = data.readUInt16BE(pos + 2);
      const seg = data.subarray(pos + 4, pos + 2 + len);
      if (marker === 0xdb) {
        for (let i = 0; i < seg.length; ) {
          const pq = seg[i] >> 4, tq = seg[i] & 15;
          q[tq] = [pq ? seg.readUInt16BE(i + 1) : seg[i + 1]];
          i += 1 + (pq ? 128 : 64);
        }
      } else if (marker === 0xc0 || marker === 0xc1) {
        const comps = [];
        for (let i = 0; i < seg[5]; i++) comps.push({ id: seg[6 + i * 3], h: seg[7 + i * 3] >> 4, v: seg[7 + i * 3] & 15, tq: seg[8 + i * 3] });
        frame = { h: seg.readUInt16BE(1), w: seg.readUInt16BE(3), comps };
        if (seg[0] !== 8 || (comps.length !== 1 && comps.length !== 3)) return null;
      } else if ((marker >= 0xc2 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)) {
        return null; // progressive, lossless or arithmetic
      } else if (marker === 0xc4) {
        for (let i = 0; i < seg.length; ) {
          const tc = seg[i] >> 4, th = seg[i] & 15;
          const counts = seg.subarray(i + 1, i + 17);
          const total = counts.reduce((a, b) => a + b, 0);
          const table = buildHuff(counts, seg.subarray(i + 17, i + 17 + total));
          (tc === 0 ? dcTables : acTables)[th] = table;
          i += 17 + total;
        }
      } else if (marker === 0xdd) {
        restart = seg.readUInt16BE(0);
      } else if (marker === 0xda) {
        if (!frame) return null;
        const ns = seg[0];
        if (ns !== frame.comps.length) return null;
        const scan = [];
        for (let i = 0; i < ns; i++) {
          const comp = frame.comps.find((c) => c.id === seg[1 + i * 2]);
          if (!comp) return null;
          scan.push({ ...comp, dc: dcTables[seg[2 + i * 2] >> 4], ac: acTables[seg[2 + i * 2] & 15], pred: 0 });
        }
        if (scan.some((c) => !c.dc || !c.ac || !q[c.tq])) return null;
        return decodeScan(data, pos + 2 + len, frame, scan as ScanComp[], q, restart);
      } else if (marker === 0xd9) break;
      pos += 2 + len;
    }
    return null;
  } catch {
    return null;
  }
}

interface Huff {
  maxcode: Int32Array;
  valptr: Int32Array;
  mincode: Int32Array;
  symbols: Uint8Array;
}

interface ScanComp {
  id: number;
  h: number;
  v: number;
  tq: number;
  dc: Huff;
  ac: Huff;
  pred: number;
}

function buildHuff(counts: Uint8Array, symbols: Uint8Array): Huff {
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    valptr[len] = k;
    mincode[len] = code;
    code += counts[len - 1];
    k += counts[len - 1];
    maxcode[len] = counts[len - 1] ? code - 1 : -1;
    code <<= 1;
  }
  return { maxcode, valptr, mincode, symbols: Uint8Array.from(symbols) };
}

function decodeScan(data: Buffer, start: number, frame: { w: number; h: number }, comps: ScanComp[], q: number[][], restart: number): Decoded | null {
  let pos = start;
  let bitBuf = 0, bitCnt = 0;
  const readBit = (): number => {
    if (bitCnt === 0) {
      if (pos >= data.length) throw new Error("eof");
      let byte = data[pos++];
      if (byte === 0xff) {
        const next = data[pos];
        if (next === 0) pos++;
        else if (next >= 0xd0 && next <= 0xd7) byte = 0; // unexpected restart: pad
        else throw new Error("marker");
      }
      bitBuf = byte;
      bitCnt = 8;
    }
    bitCnt--;
    return (bitBuf >> bitCnt) & 1;
  };
  const receive = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | readBit();
    return v;
  };
  const extend = (v: number, n: number): number => (n === 0 ? 0 : v < 1 << (n - 1) ? v - (1 << n) + 1 : v);
  const decode = (t: Huff): number => {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | readBit();
      if (code <= t.maxcode[len]) return t.symbols[t.valptr[len] + code - t.mincode[len]];
    }
    throw new Error("bad huffman");
  };
  const hmax = Math.max(...comps.map((c) => c.h));
  const vmax = Math.max(...comps.map((c) => c.v));
  const mcusX = Math.ceil(frame.w / (8 * hmax));
  const mcusY = Math.ceil(frame.h / (8 * vmax));
  const planes = comps.map((c) => ({ w: mcusX * c.h, data: new Float32Array(mcusX * c.h * mcusY * c.v) }));
  const total = mcusX * mcusY;
  for (let m = 0; m < total; m++) {
    if (restart && m > 0 && m % restart === 0) {
      // Align to the RSTn marker and reset the predictors.
      bitCnt = 0;
      while (pos + 1 < data.length && !(data[pos] === 0xff && data[pos + 1] >= 0xd0 && data[pos + 1] <= 0xd7)) pos++;
      pos += 2;
      for (const c of comps) c.pred = 0;
    }
    const mx = m % mcusX, my = (m / mcusX) | 0;
    comps.forEach((c, ci) => {
      for (let by = 0; by < c.v; by++) {
        for (let bx = 0; bx < c.h; bx++) {
          const t = decode(c.dc);
          c.pred += extend(receive(t), t);
          for (let k = 1; k < 64; ) {
            const rs = decode(c.ac);
            const r = rs >> 4, s = rs & 15;
            if (s === 0) {
              if (r !== 15) break;
              k += 16;
            } else {
              k += r;
              receive(s);
              k++;
            }
          }
          const plane = planes[ci];
          plane.data[(my * c.v + by) * plane.w + mx * c.h + bx] = (c.pred * q[c.tq][0]) / 8 + 128;
        }
      }
    });
  }
  const W = Math.ceil(frame.w / 8), H = Math.ceil(frame.h / 8);
  const rgba = new Uint8Array(W * H * 4);
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const at = (ci: number) => {
        const c = comps[ci], p = planes[ci];
        return p.data[Math.floor((y * c.v) / vmax) * p.w + Math.floor((x * c.h) / hmax)];
      };
      const o = (y * W + x) * 4;
      const Y = at(0);
      if (comps.length === 1) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = clamp(Y);
      } else {
        const cb = at(1) - 128, cr = at(2) - 128;
        rgba[o] = clamp(Y + 1.402 * cr);
        rgba[o + 1] = clamp(Y - 0.344136 * cb - 0.714136 * cr);
        rgba[o + 2] = clamp(Y + 1.772 * cb);
      }
      rgba[o + 3] = 255;
    }
  }
  return { w: W, h: H, rgba };
}
