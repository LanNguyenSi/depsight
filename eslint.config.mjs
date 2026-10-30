import { defineConfig } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // eslint-config-next 16 lowers these two typescript-eslint rules from
    // error (eslint-config-next 15) to warn. Keep the stricter base severity
    // and the same options so a violation still fails the lint run.
    rules: {
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/no-unused-expressions": [
        "error",
        {
          allowShortCircuit: false,
          allowTaggedTemplates: false,
          allowTernary: false,
        },
      ],
    },
  },
  {
    // eslint-plugin-react-hooks 7 (React Compiler rule) flags effects that
    // call a setter, directly or through a loader function. In these files
    // that is the intended pattern, kept as is so the change stays
    // behaviour-neutral: client components that fetch their data on mount
    // (the loaders are also re-run from click handlers, so they cannot move
    // into a server component or a render-phase read) and DashboardClient,
    // whose effect re-syncs server-provided `repos` into locally and
    // optimistically edited state when the props change after a refresh.
    // Only this one rule, only these files; every other react-hooks rule
    // stays on for them.
    files: [
      "app/dashboard/DashboardClient.tsx",
      "app/settings/SettingsClient.tsx",
      "components/dashboard/CIHealthTab.tsx",
      "components/settings/PrWebhookSecrets.tsx",
    ],
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
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
]);

export default eslintConfig;
