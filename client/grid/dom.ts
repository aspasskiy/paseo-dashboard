// Tiny web-only helpers. The project compiles without the DOM lib, so the bits used are typed here.

interface WebKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  target: { tagName?: string; isContentEditable?: boolean } | null;
  preventDefault(): void;
}

interface Doc {
  addEventListener(type: "keydown", fn: (e: WebKey) => void): void;
  removeEventListener(type: "keydown", fn: (e: WebKey) => void): void;
  createElement(tag: "style"): { textContent: string };
  head: { appendChild(node: unknown): void };
}

function doc(): Doc | null {
  return ((globalThis as { document?: Doc }).document ?? null) as Doc | null;
}

/** Listens to keydown on the document (web only); returns the unsubscribe. Typing in a field is ignored. */
export function onKeyDown(handler: (e: WebKey) => void): () => void {
  const d = doc();
  if (!d) return () => {};
  const fn = (e: WebKey) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    handler(e);
  };
  d.addEventListener("keydown", fn);
  return () => d.removeEventListener("keydown", fn);
}

const injected: Record<string, boolean> = {};
/** Adds a global stylesheet once (web only). */
export function injectCss(id: string, css: string): void {
  const d = doc();
  if (!d || injected[id]) return;
  injected[id] = true;
  const style = d.createElement("style");
  style.textContent = css;
  d.head.appendChild(style);
}
