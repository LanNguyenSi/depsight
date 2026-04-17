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

export function createServer(config: Config): McpServer {
  const server = new McpServer({
    name: "depsight",
    version: "0.1.0",
  });

  const client = new DepsightClient(config);

  registerRepoTools(server, client);
  registerCveTools(server, client);
  registerDepsTools(server, client);
  registerLicenseTools(server, client);
  registerHistoryTools(server, client);
  registerPolicyTools(server, client);
  registerCiTools(server, client);

  return server;
}

export async function startServer(config: Config): Promise<void> {
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
