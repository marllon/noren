import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "_l[o]op/",
      "ROADMAP.pt-BR.md",
      "**/node_modules/",
      "**/target/",
      "**/dist/",
      "**/dist-demo/",
      "**/test-results/",
      "**/playwright-report/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: { globals: globals.node },
  },
);
