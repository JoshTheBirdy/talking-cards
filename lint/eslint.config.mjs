// Obsidian's own lint rules: the same checks its community-plugin review runs.
// Lives here because typescript-eslint needs TypeScript 6; the plugin builds with 7.
//   (cd lint && npm i) && lint/node_modules/.bin/eslint -c lint/eslint.config.mjs src
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig({
  files: ["src/**/*.ts"],
  extends: [obsidianmd.configs.recommended],
  languageOptions: { parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname + "/.." } },
});
