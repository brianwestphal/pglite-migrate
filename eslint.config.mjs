import eslint from "@eslint/js";
import importX from "eslint-plugin-import-x";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tsdoc from "eslint-plugin-tsdoc";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "simple-import-sort": simpleImportSort,
      import: importX,
      tsdoc: tsdoc,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      // PGliteLike.query mirrors a DB-client API: the row-type parameter is used
      // at call sites (e.g. query<{ count: string }>), so the "used once in the
      // declaration" heuristic is a false positive here.
      "@typescript-eslint/no-unnecessary-type-parameters": "off",
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      "import/first": "error",
      "import/newline-after-import": "error",
      "import/no-duplicates": "error",
      "tsdoc/syntax": "warn",
      // The only formatting rule here. `recommended` and `strictTypeChecked` are
      // correctness rule sets, so nothing else enforces whitespace — this pins
      // the ~100-column wrapping the codebase already follows (PGLM-88).
      //
      // The three ignores were each chosen against a measured violation count,
      // not guessed. Bare `code: 100` flags 50 lines; almost all are content
      // that cannot be wrapped without harming it:
      //   ignoreStrings         — the pinned sha512 literals in engines/registry.ts
      //   ignoreTemplateLiterals — the CLI usage text and error messages
      //   ignoreRegExpLiterals  — the SVG-parsing regex in tests/diagram-svg.test.ts
      // That leaves exactly the real target: over-long *code* lines.
      //
      // `ignoreComments` is deliberately NOT set. Adding it changes nothing
      // today — every comment in the tree already wraps under 100 — so leaving
      // it off costs nothing now and keeps that property from eroding later.
      //
      // Note: ESLint's stylistic rules are deprecated (still functional in v10)
      // and will eventually be removed. When that happens, move this to
      // @stylistic/eslint-plugin or adopt a formatter; the intent is the rule,
      // not the plugin it lives in.
      "max-len": [
        "error",
        { code: 100, ignoreStrings: true, ignoreTemplateLiterals: true, ignoreRegExpLiterals: true },
      ],
    },
  },
  {
    // Tests may use non-null assertions and console freely.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
    },
  },
);
