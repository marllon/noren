import type { HtmlTagDescriptor, Plugin } from "vite";

// A build-time module (only `vite.config.ts` imports it), kept here so the typecheck, the linter
// and the tests of the app cover it.

/** The part of a chunk of the bundle this reads. */
export interface ChunkInfo {
  type: string;
  fileName: string;
  isEntry?: boolean;
  facadeModuleId?: string | null;
  imports?: readonly string[];
}

/**
 * The files the page of the main window needs right after its entry script, in the order of the
 * graph: the chunk of `src/App.tsx` and every chunk it imports statically, less what the entry
 * links by itself (Vite names those in `index.html` already). Empty when the app has no chunk of
 * its own.
 */
export function mainWindowChunks(outputs: readonly ChunkInfo[]): string[] {
  const chunks = outputs.filter((output) => output.type === "chunk");
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const app = chunks.find((chunk) => chunk.facadeModuleId?.endsWith("/src/App.tsx") ?? false);
  if (app === undefined) return [];
  const walk = (fileName: string, into: Set<string>): Set<string> => {
    if (into.has(fileName)) return into;
    into.add(fileName);
    for (const next of byName.get(fileName)?.imports ?? []) walk(next, into);
    return into;
  };
  const entry = chunks.find((chunk) => chunk.isEntry === true);
  const linked = entry === undefined ? new Set<string>() : walk(entry.fileName, new Set());
  return [...walk(app.fileName, new Set())].filter((fileName) => !linked.has(fileName));
}

/**
 * `main.tsx` imports the app of the main window when it runs (`import("./App")`), so its scripts
 * (the app and what it imports: the terminal, the layout, the boot) were asked for only after the
 * entry script and the libraries had been fetched and read (NOR-F20-14b). The page names them in
 * `index.html` as well, so the browser fetches them with the entry and reads them while the entry
 * runs. The other windows (the quick terminal, the extra windows) load the same page and do not
 * use the app: they fetch these too and run none of them, a cost of a few milliseconds off the
 * path of the person.
 */
export function preloadMainWindow(): Plugin {
  let base = "/";
  return {
    name: "noren-preload-main-window",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, context): HtmlTagDescriptor[] {
        const bundle = context.bundle;
        if (bundle === undefined) return [];
        return mainWindowChunks(Object.values(bundle)).map((fileName) => ({
          tag: "link",
          attrs: { rel: "modulepreload", crossorigin: true, href: `${base}${fileName}` },
          injectTo: "head",
        }));
      },
    },
  };
}
