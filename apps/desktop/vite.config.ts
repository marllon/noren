import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `vite build --mode demo` builds the static web demo (NOR-F12-02) into `dist-demo/` at the root of
// the repository, with relative asset paths so it can be served from a sub-path (GitHub Pages). The
// demo-only code (the seeded script and the banner) is kept out of every other build by this mode:
// `import.meta.env.VITE_NOREN_DEMO` is a constant of the build, not of the environment, so the
// normal build and the e2e tests that run on it never contain the demo.
export default defineConfig(({ mode }) => {
  const demo = mode === "demo";
  return {
    plugins: [react()],
    clearScreen: false,
    base: demo ? "./" : "/",
    define: {
      "import.meta.env.VITE_NOREN_DEMO": JSON.stringify(demo ? "1" : ""),
    },
    build: {
      target: "es2023",
      ...(demo ? { outDir: "../../dist-demo", emptyOutDir: true } : {}),
    },
  };
});
