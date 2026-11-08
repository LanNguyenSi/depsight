import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Config } from "./config.js";
import { DepsightClient } from "./client.js";
import { registerRepoTools } from "./tools/repos.js";
import { registerCveTools } from "./tools/cves.js";
import { registerDepsTools } from "./tools/deps.js";
import { registerLicenseTools } from "./tools/license.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerPolicyTools } from "./tools/policy.js";
import { registerCiTools } from "./tools/ci.js";
import { registerSbomTools } from "./tools/sbom.js";
import { registerRescanTools } from "./tools/rescan.js";

// Single source of truth for the tool surface: createServer registers exactly
// these modules, and the argument-schema guard in
// src/__tests__/tool-arg-validation.test.ts derives the expected tool names
// from this list, so a new tool or registrar module cannot slip past it.
export const TOOL_REGISTRARS = [
  registerRepoTools,
  registerCveTools,
  registerDepsTools,
  registerLicenseTools,
  registerHistoryTools,
  registerPolicyTools,
  registerCiTools,
  registerSbomTools,
  registerRescanTools,
] as const;

export function createServer(config: Config): McpServer {
  const server = new McpServer({
    name: "depsight",
    version: "0.7.0",
  });

  const client = new DepsightClient(config);

  for (const register of TOOL_REGISTRARS) {
    register(server, client);
  }

  return server;
}

export async function startServer(config: Config): Promise<void> {
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
