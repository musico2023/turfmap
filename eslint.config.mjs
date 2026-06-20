import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local/generated tooling output — NOT source. Without these, lint
    // walked thousands of generated files (esp. git worktrees' own .next
    // builds under .claude/worktrees/**), burying real source findings
    // and making `npm run lint` unusable as a quality gate.
    ".claude/**",
    ".firecrawl/**",
    "**/.next/**",
  ]),
]);

export default eslintConfig;
