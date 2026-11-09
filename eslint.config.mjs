import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  { ignores: [".next/**", "node_modules/**", "coverage/**", "src/generated/**", "next-env.d.ts"] },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@/generated/*", "**/generated/prisma*"], message: "Only repository files, src/core/db and the composition root (src/runtime.ts) may import Prisma." }] },
      ],
    },
  },
  {
    files: ["src/modules/**/*repository*.ts", "src/core/db/**", "src/runtime.ts", "prisma/**", "tests/**"],
    rules: { "no-restricted-imports": "off" },
  },
];

export default config;
