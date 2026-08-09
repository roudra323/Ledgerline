// Flat ESLint config (ESLint 9). Shared across the monorepo.
// Per-package overrides can extend this file if needed.
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import importX from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/coverage/**",
      "packages/contracts/**", // Solidity is linted by `forge fmt`
      "packages/shared/src/abis/**", // generated ABIs
      "others/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Import order per docs/conventions.md §7:
    // node builtins → external → internal @ledgerline/* → parent → sibling → index,
    // with a blank line between groups and alphabetical order within each group.
    plugins: { import: importX },
    rules: {
      "import/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          pathGroups: [{ pattern: "@ledgerline/**", group: "internal", position: "before" }],
          pathGroupsExcludedImportTypes: ["builtin"],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
    },
  },
  {
    // All plain JS/config files run without type information.
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // CommonJS config files (jest.config.js, etc.) use module/require/__dirname.
    files: ["**/*.{js,cjs}"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        module: "writable",
        require: "readonly",
        process: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
  },
  prettier,
]);
