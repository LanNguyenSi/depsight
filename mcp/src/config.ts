export interface Config {
  gatewayUrl: string;
  apiToken: string;
}

/**
 * Load runtime config from env vars.
 *
 * `DEPSIGHT_URL` — base URL of the depsight Next.js app (e.g.
 *   `https://depsight.opentriologue.ai` or `http://localhost:3000`).
 *   Required. Trailing slashes are stripped.
 * `DEPSIGHT_API_TOKEN` — `dsat_` prefixed API token minted via
 *   `scripts/mint-api-token.ts`. Required. Scopes to the user who
 *   minted it; depsight has no per-tool ACL today.
 */
export function loadConfig(): Config {
  const gatewayUrl = process.env.DEPSIGHT_URL;
  if (!gatewayUrl) {
    throw new Error(
      "DEPSIGHT_URL environment variable is required.\n" +
        "Set it to the URL of your depsight instance, e.g. https://depsight.opentriologue.ai",
    );
  }

  const apiToken = process.env.DEPSIGHT_API_TOKEN;
  if (!apiToken) {
    throw new Error(
      "DEPSIGHT_API_TOKEN environment variable is required.\n" +
        "Mint one with `npx tsx scripts/mint-api-token.ts --user <id>` inside the depsight repo.",
    );
  }

  return {
    gatewayUrl: gatewayUrl.replace(/\/$/, ""),
    apiToken,
  };
}
