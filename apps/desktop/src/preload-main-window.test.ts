import { describe, expect, it } from "vitest";
import { mainWindowChunks, preloadMainWindow } from "./preload-main-window";
import type { ChunkInfo } from "./preload-main-window";

const chunk = (fileName: string, imports: string[], more: Partial<ChunkInfo> = {}): ChunkInfo => ({
  type: "chunk",
  fileName,
  imports,
  ...more,
});

/** The shape of the build: an entry with its libraries, and the app with what it imports. */
const bundle: ChunkInfo[] = [
  chunk("assets/index.js", ["assets/runtime.js", "assets/quick.js", "assets/react.js"], {
    isEntry: true,
  }),
  chunk("assets/runtime.js", []),
  chunk("assets/quick.js", ["assets/runtime.js"]),
  chunk("assets/react.js", ["assets/runtime.js", "assets/quick.js"]),
  chunk("assets/App.js", ["assets/index.js", "assets/boot.js", "assets/terminal.js"], {
    facadeModuleId: "D:/Projetos/noren/apps/desktop/src/App.tsx",
  }),
  chunk("assets/boot.js", ["assets/quick.js", "assets/terminal.js"]),
  chunk("assets/terminal.js", ["assets/react.js"]),
  chunk("assets/QuickApp.js", ["assets/terminal.js"], {
    facadeModuleId: "D:/Projetos/noren/apps/desktop/src/QuickApp.tsx",
  }),
  { type: "asset", fileName: "assets/index.css" },
];

describe("mainWindowChunks", () => {
  it("names the app and what it imports, once each, and leaves out what the entry links", () => {
    expect(mainWindowChunks(bundle)).toEqual([
      "assets/App.js",
      "assets/boot.js",
      "assets/terminal.js",
    ]);
  });

  it("leaves out the chunks of the other windows and the files that are not scripts", () => {
    const named = mainWindowChunks(bundle);
    expect(named).not.toContain("assets/QuickApp.js");
    expect(named).not.toContain("assets/index.css");
  });

  it("names nothing when the build has no chunk for the app", () => {
    expect(
      mainWindowChunks(bundle.filter((output) => output.fileName !== "assets/App.js")),
    ).toEqual([]);
  });

  it("walks a loop in the graph once", () => {
    const loop = [
      chunk("assets/index.js", [], { isEntry: true }),
      chunk("assets/App.js", ["assets/a.js"], { facadeModuleId: "/x/src/App.tsx" }),
      chunk("assets/a.js", ["assets/App.js"]),
    ];
    expect(mainWindowChunks(loop)).toEqual(["assets/App.js", "assets/a.js"]);
  });
});

describe("preloadMainWindow", () => {
  type Handler = (html: string, context: { bundle?: Record<string, ChunkInfo> }) => unknown;
  const handlerOf = (base: string): Handler => {
    const plugin = preloadMainWindow();
    (plugin.configResolved as (config: { base: string }) => void)({ base });
    const hook = plugin.transformIndexHtml as { handler: Handler };
    return hook.handler;
  };
  const asBundle = (chunks: ChunkInfo[]) => Object.fromEntries(chunks.map((c) => [c.fileName, c]));

  it("adds a modulepreload link to the head for each chunk, with the base of the build", () => {
    expect(handlerOf("/")("", { bundle: asBundle(bundle) })).toEqual(
      ["assets/App.js", "assets/boot.js", "assets/terminal.js"].map((file) => ({
        tag: "link",
        attrs: { rel: "modulepreload", crossorigin: true, href: `/${file}` },
        injectTo: "head",
      })),
    );
    const relative = handlerOf("./")("", { bundle: asBundle(bundle) }) as {
      attrs: { href: string };
    }[];
    expect(relative.map((tag) => tag.attrs.href)).toEqual([
      "./assets/App.js",
      "./assets/boot.js",
      "./assets/terminal.js",
    ]);
  });

  it("adds nothing without a bundle (a dev server) and runs only in a build", () => {
    expect(handlerOf("/")("", {})).toEqual([]);
    expect(preloadMainWindow().apply).toBe("build");
  });
});
