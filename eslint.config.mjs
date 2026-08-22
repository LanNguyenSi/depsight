import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      ".next/**",
      ".claude/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "coverage/**",
      "prisma/migrations/**",
      // Next.js-generated, gitignored, and rewritten by every `next build`
      // (adds a `.next/types/routes.d.ts` triple-slash reference that
      // @typescript-eslint/triple-slash-reference otherwise flags). Not
      // meant to be edited or linted; see next-env.d.ts's own header.
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
