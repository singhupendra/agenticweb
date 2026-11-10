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
        { patterns: [{ group: ["@/generated/*", "**/generated/prisma*"], message: "Only src/modules/*/repository*.ts and src/core/db may import Prisma." }] },
      ],
    },
  },
  {
    files: ["src/modules/**/*repository*.ts", "src/core/db/**", "prisma/**", "tests/**"],
    rules: { "no-restricted-imports": "off" },
  },
];

export default config;
