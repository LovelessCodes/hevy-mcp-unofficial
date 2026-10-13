// Smoke test: spawns the server over stdio and calls a few tools against the live API.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["src/server.js"] });
const client = new Client({ name: "hevy-mcp-smoke", version: "0.0.1" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`tools: ${tools.tools.length}`);

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? JSON.stringify(r);
  console.log(`\n### ${name} ${args ? JSON.stringify(args) : ""}\n${r.isError ? "[ERROR] " : ""}${text.slice(0, 500)}`);
}

await call("hevy_trainer_get_program", { client_program_updated_at: "2026-08-01T20:55:45.835Z", client_next_workout_updated_at: "2026-10-11T19:23:46.198Z" });
await call("hevy_search_endpoints", { query: "hevy_trainer" });
await call("hevy_request", { method: "GET", path: "/account" });
await call("hevy_coach_plan_get", {});

await client.close();
