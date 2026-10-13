#!/usr/bin/env node
// Hevy MCP server — private (session) + public (api-key) Hevy endpoints.
// Covers: Hevy Trainer, Hevy Coach, mobile app private API, public /v1 API.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { hevyRequest, authStatus, refreshSession } from "./client.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const INVENTORY = JSON.parse(readFileSync(path.join(here, "endpoints.json"), "utf8"));
const EXPOSE_ALL = process.env.HEVY_TOOLS === "all";

const S = (props = {}, required = []) => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});

// ---------- curated tools ----------
// fmt: [name, description, method, pathTemplate, inputSchema, annotations, build(args)->{query,body,pathParams}]

const TOOLS = [
  // ---- Hevy Trainer ----
  ["hevy_trainer_get_program",
    "Get the user's Hevy Trainer program (v3). Pass the previously seen updated_at values to enable delta sync: returns {status:'up-to-date'} if unchanged, otherwise the full program.",
    "GET", "/hevy_trainer/v3/program",
    S({ client_program_updated_at: { type: "string" }, client_next_workout_updated_at: { type: "string" } }),
    { readOnlyHint: true },
    (a) => ({ query: a })],

  ["hevy_trainer_create_program",
    "Create/save a Hevy Trainer program (POST v3). Body: {program, deleteActiveProgram}.",
    "POST", "/hevy_trainer/v3/program",
    S({ program: { type: "object" }, deleteActiveProgram: { type: "boolean", default: false } }, ["program"]),
    { destructiveHint: true },
    (a) => ({ body: { program: a.program, deleteActiveProgram: a.deleteActiveProgram ?? false } })],

  ["hevy_trainer_update_program",
    "Update the existing Hevy Trainer program (PUT v3). Body: {program}.",
    "PUT", "/hevy_trainer/v3/program",
    S({ program: { type: "object" } }, ["program"]),
    { idempotentHint: true },
    (a) => ({ body: { program: a.program } })],

  ["hevy_trainer_delete_program",
    "Delete the legacy Hevy Trainer program (DELETE /hevy_trainer/program). Destructive.",
    "DELETE", "/hevy_trainer/program",
    S(),
    { destructiveHint: true },
    () => ({})],

  ["hevy_trainer_migrate_v3",
    "Trigger the v1->v3 Hevy Trainer migration (POST /hevy_trainer/v3/migrate).",
    "POST", "/hevy_trainer/v3/migrate",
    S(),
    { destructiveHint: true },
    () => ({})],

  ["hevy_trainer_get_preferences",
    "Get Hevy Trainer user preferences (404 when never set).",
    "GET", "/hevy_trainer/user_preferences",
    S(),
    { readOnlyHint: true },
    () => ({})],

  ["hevy_trainer_set_preferences",
    "Set Hevy Trainer user preferences (POST).",
    "POST", "/hevy_trainer/user_preferences",
    S({ preferences: { type: "object" } }, ["preferences"]),
    {},
    (a) => ({ body: a.preferences })],

  // ---- Account / private basics ----
  ["hevy_account_get", "Get the authenticated account (private /account endpoint).", "GET", "/account", S(), { readOnlyHint: true }, () => ({})],
  ["hevy_workout_count", "Total workout count for the account.", "GET", "/workout_count", S(), { readOnlyHint: true }, () => ({})],
  ["hevy_workouts_sync", "Workouts sync feed (POST workouts_sync_batch). Body {last_sync_timestamp} (unix seconds, optional) returns {updated:[workouts], deleted:[...]} for delta sync.", "POST", "/workouts_sync_batch",
    S({ last_sync_timestamp: { type: "integer" } }), { readOnlyHint: true },
    (a) => ({ body: a.last_sync_timestamp !== undefined ? { last_sync_timestamp: a.last_sync_timestamp } : {} })],
  ["hevy_workouts_paged", "Legacy paged workouts (user_workouts_paged) — currently returns 404 on the live API; use hevy_workouts_sync.", "GET", "/user_workouts_paged",
    S({ page: { type: "integer" }, pageSize: { type: "integer" } }), { readOnlyHint: true }, (a) => ({ query: a })],
  ["hevy_workout_get", "Get a single workout by id (private API).", "GET", "/workout/{workoutId}",
    S({ workoutId: { type: "string" } }, ["workoutId"]), { readOnlyHint: true },
    (a) => ({ pathParams: { workoutId: a.workoutId } })],
  ["hevy_body_measurements_list", "List body measurements (private API).", "GET", "/body_measurements", S(), { readOnlyHint: true }, () => ({})],
  ["hevy_user_preferences_get", "Get account preferences (v2).", "GET", "/v2/user_preferences", S(), { readOnlyHint: true }, () => ({})],
  ["hevy_key_values_get", "Get user key-values store.", "GET", "/user_key_values", S(), { readOnlyHint: true }, () => ({})],
  ["hevy_key_values_set", "Update user key-values store.", "PUT", "/user_key_values",
    S({ values: { type: "object" } }, ["values"]), {}, (a) => ({ body: a.values })],

  // ---- Hevy Coach: clients ----
  ["hevy_coach_clients_list", "Coach: list all clients (GET coach/get_coachs_clients).", "GET", "/coach/get_coachs_clients", S(), { readOnlyHint: true }, () => ({})],
  ["hevy_coach_client_workouts_paged", "Coach: a client's workouts, paged (coach/clients_workouts_paged/{clientId}).", "GET", "/coach/clients_workouts_paged/{clientId}",
    S({ clientId: { type: "string" }, page: { type: "integer" }, pageSize: { type: "integer" } }, ["clientId"]), { readOnlyHint: true },
    (a) => ({ pathParams: { clientId: a.clientId }, query: { page: a.page, pageSize: a.pageSize } })],
  ["hevy_coach_client_exercise_history", "Coach: a client's exercise history (coach/clients_exercise_history_paged/{exerciseTemplateId}/{clientId}/{page}).",
    "GET", "/coach/clients_exercise_history_paged/{exerciseTemplateId}/{clientId}/{page}",
    S({ exerciseTemplateId: { type: "string" }, clientId: { type: "string" }, page: { type: "integer", default: 0 } }, ["exerciseTemplateId", "clientId"]),
    { readOnlyHint: true },
    (a) => ({ pathParams: { exerciseTemplateId: a.exerciseTemplateId, clientId: a.clientId, page: a.page ?? 0 } })],
  ["hevy_coach_client_exercise_sets", "Coach: a client's sets for an exercise (coach/client_exercise_sets/{clientId}/{exerciseTemplateId}/{index}).",
    "GET", "/coach/client_exercise_sets/{clientId}/{exerciseTemplateId}/{index}",
    S({ clientId: { type: "string" }, exerciseTemplateId: { type: "string" }, index: { type: "integer", default: 0 } }, ["clientId", "exerciseTemplateId"]),
    { readOnlyHint: true },
    (a) => ({ pathParams: { clientId: a.clientId, exerciseTemplateId: a.exerciseTemplateId, index: a.index ?? 0 } })],
  ["hevy_coach_client_workout_get", "Coach: one client workout (coach/client_workout/{id}).", "GET", "/coach/client_workout/{clientWorkoutId}",
    S({ clientWorkoutId: { type: "string" } }, ["clientWorkoutId"]), { readOnlyHint: true },
    (a) => ({ pathParams: { clientWorkoutId: a.clientWorkoutId } })],
  ["hevy_coach_client_measurements_get", "Coach: client body measurements (coach/client_body_measurements/{clientId}).", "GET", "/coach/client_body_measurements/{clientId}",
    S({ clientId: { type: "string" } }, ["clientId"]), { readOnlyHint: true },
    (a) => ({ pathParams: { clientId: a.clientId } })],
  ["hevy_coach_client_measurements_add", "Coach: add body measurements for a client (coach/body_measurements/{clientId}).", "POST", "/coach/body_measurements/{clientId}",
    S({ clientId: { type: "string" }, measurements: { type: "array", items: { type: "object" } } }, ["clientId", "measurements"]), {},
    (a) => ({ pathParams: { clientId: a.clientId }, body: { measurements: a.measurements } })],
  ["hevy_coach_client_notes_set", "Coach: set notes for a client (coach/client_notes/{clientId}).", "POST", "/coach/client_notes/{clientId}",
    S({ clientId: { type: "string" }, notes: { type: "string" } }, ["clientId", "notes"]), { idempotentHint: true },
    (a) => ({ pathParams: { clientId: a.clientId }, body: { notes: a.notes } })],
  ["hevy_coach_activities_paged", "Coach: client activity feed, paged (coach/clients_activities_paged/{page}).", "POST", "/coach/clients_activities_paged/{page}",
    S({ page: { type: "integer" }, forCoachIds: { type: "array", items: { type: "string" } } }, ["page"]), { readOnlyHint: true },
    (a) => ({ pathParams: { page: a.page }, body: { forCoachIds: a.forCoachIds } })],
  ["hevy_coach_weekly_active_clients", "Coach: weekly active clients count (optionally per coach id).", "GET", "/coach/weekly_active_clients",
    S(), { readOnlyHint: true }, () => ({})],
  ["hevy_coach_client_delete", "Coach: remove a client (coach/clients/delete/{clientId}). Destructive.", "POST", "/coach/clients/delete/{clientId}",
    S({ clientId: { type: "string" } }, ["clientId"]), { destructiveHint: true },
    (a) => ({ pathParams: { clientId: a.clientId } })],

  // ---- Coach: invites ----
  ["hevy_coach_invites_list", "Coach: list sent client invites.", "GET", "/coach/invites", S(), { readOnlyHint: true }, () => ({})],
  ["hevy_coach_client_invite_create", "Coach: invite a user to become your client (coach/client_invite/{userId}).", "POST", "/coach/client_invite/{userId}",
    S({ userId: { type: "string" }, targetCoachId: { type: "string" } }, ["userId"]), {},
    (a) => ({ pathParams: { userId: a.userId }, body: { targetCoachId: a.targetCoachId } })],

  // ---- Coach: programs ----
  ["hevy_coach_programs_list", "Coach: list programs (optionally for a coach id).", "GET", "/coach/get_coachs_programs",
    S(), { readOnlyHint: true }, () => ({})],
  ["hevy_coach_program_get", "Coach: get one program.", "GET", "/coach/program/{programId}",
    S({ programId: { type: "string" } }, ["programId"]), { readOnlyHint: true },
    (a) => ({ pathParams: { programId: a.programId } })],
  ["hevy_coach_program_create", "Coach: create a program (POST coach/create_program, body {program}).", "POST", "/coach/create_program",
    S({ program: { type: "object" } }, ["program"]), {}, (a) => ({ body: { program: a.program } })],
  ["hevy_coach_program_update", "Coach: update a program (PUT coach/update_program/{programId}, body {program}).", "PUT", "/coach/update_program/{programId}",
    S({ programId: { type: "string" }, program: { type: "object" } }, ["programId", "program"]), { idempotentHint: true },
    (a) => ({ pathParams: { programId: a.programId }, body: { program: a.program } })],
  ["hevy_coach_program_delete", "Coach: delete a program. Destructive.", "DELETE", "/coach/program/{programId}",
    S({ programId: { type: "string" } }, ["programId"]), { destructiveHint: true },
    (a) => ({ pathParams: { programId: a.programId } })],
  ["hevy_coach_program_duplicate", "Coach: duplicate a program.", "POST", "/coach/duplicate_program",
    S({ programId: { type: "string" } }, ["programId"]), {}, (a) => ({ body: { programId: a.programId } })],
  ["hevy_coach_program_assign", "Coach: assign a program to clients.", "POST", "/coach/assign_program_to_clients",
    S({ body: { type: "object" } }, ["body"]), {}, (a) => ({ body: a.body })],
  ["hevy_coach_program_folders_list", "Coach: list program folders.", "GET", "/coach/program_folders", S(), { readOnlyHint: true }, () => ({})],

  // ---- Coach: routines ----
  ["hevy_coach_library_routines", "Coach: simplified coach routine library (optionally per coach id).", "GET", "/coach/library_routines",
    S(), { readOnlyHint: true }, () => ({})],
  ["hevy_coach_routine_create", "Coach: create a routine in the coach library (POST /coach/routine, body {routine}).", "POST", "/coach/routine",
    S({ routine: { type: "object" } }, ["routine"]), {}, (a) => ({ body: { routine: a.routine } })],
  ["hevy_coach_client_routine_create", "Coach: create/assign a routine for a client (POST /coach/client_routine/{clientUserId}, body {routine}).",
    "POST", "/coach/client_routine/{clientUserId}",
    S({ clientUserId: { type: "string" }, routine: { type: "object" } }, ["clientUserId", "routine"]), {},
    (a) => ({ pathParams: { clientUserId: a.clientUserId }, body: { routine: a.routine } })],
  ["hevy_coach_client_routine_update", "Coach: update a client routine (PUT /coach/update_client_routine/{id}, body {routine}).",
    "PUT", "/coach/update_client_routine/{clientRoutineId}",
    S({ clientRoutineId: { type: "string" }, routine: { type: "object" } }, ["clientRoutineId", "routine"]), { idempotentHint: true },
    (a) => ({ pathParams: { clientRoutineId: a.clientRoutineId }, body: { routine: a.routine } })],

  // ---- Coach: team ----
  ["hevy_coach_team_get", "Coach: get the coaching team.", "GET", "/coach/team", S(), { readOnlyHint: true }, () => ({})],
  ["hevy_coach_team_invite", "Coach: invite a coach to the team (coach/team_invite).", "POST", "/coach/team_invite",
    S({ inviteeEmail: { type: "string" }, inviteeRole: { type: "string" }, inviteeUsername: { type: "string" } }, ["inviteeEmail"]), {},
    (a) => ({ body: { inviteeEmail: a.inviteeEmail, inviteeRole: a.inviteeRole, inviteeUsername: a.inviteeUsername } })],
  ["hevy_coach_team_role_set", "Coach: update a coach role (POST /coach/update_coach_role).", "POST", "/coach/update_coach_role",
    S({ body: { type: "object" } }, ["body"]), {}, (a) => ({ body: a.body })],
  ["hevy_coach_clients_reassign", "Coach: reassign clients (POST /coach/reassign_clients).", "POST", "/coach/reassign_clients",
    S({ body: { type: "object" } }, ["body"]), {}, (a) => ({ body: a.body })],

  // ---- Coach: leads / grow ----
  ["hevy_coach_leads_list", "Coach: list leads.", "GET", "/coach/leads", S(), { readOnlyHint: true }, () => ({})],
  ["hevy_coach_lead_create", "Coach: create a lead from a join form (POST /coach/create_lead/{formId}).", "POST", "/coach/create_lead/{formId}",
    S({ formId: { type: "string" }, leadFullname: { type: "string" }, leadEmail: { type: "string" }, leadMessage: { type: "string" } }, ["formId"]), {},
    (a) => ({ pathParams: { formId: a.formId }, body: { leadFullname: a.leadFullname, leadEmail: a.leadEmail, leadMessage: a.leadMessage } })],
  ["hevy_coach_join_form_get", "Coach: get join-form metadata by slug.", "GET", "/coach/join_form_metadata/{slug}",
    S({ slug: { type: "string" } }, ["slug"]), { readOnlyHint: true }, (a) => ({ pathParams: { slug: a.slug } })],
  ["hevy_coach_join_form_update", "Coach: update the join form (message, banner image).", "POST", "/coach/join_form",
    S({ message: { type: "string" }, bannerImageUrl: { type: "string" } }), {}, (a) => ({ body: { message: a.message, bannerImageUrl: a.bannerImageUrl } })],

  // ---- Coach: billing/config ----
  ["hevy_coach_plan_get", "Coach: current plan.", "GET", "/coach/plan", S(), { readOnlyHint: true }, () => ({})],
  ["hevy_coach_available_plans", "Coach: available plan options.", "GET", "/coach/available_plan_options", S(), { readOnlyHint: true }, () => ({})],
  ["hevy_coach_payment_history", "Coach: payment history.", "GET", "/coach/payment_history", S(), { readOnlyHint: true }, () => ({})],
  ["hevy_coach_config_get", "Coach: get coach config.", "GET", "/coach/config", S(), { readOnlyHint: true }, () => ({})],

  // ---- Coach: chat ----
  ["hevy_coach_conversations_list", "Coach: list conversations.", "GET", "/coach/conversations", S(), { readOnlyHint: true }, () => ({})],
  ["hevy_coach_latest_messages", "Coach: latest message per client conversation.", "GET", "/coach/latest_conversation_messages", S(), { readOnlyHint: true }, () => ({})],
  ["hevy_coach_messages_get", "Coach: messages in a conversation (POST /messages, body {limit, conversation_id, less_than_index}).", "POST", "/messages",
    S({ conversation_id: { type: "string" }, limit: { type: "integer" }, less_than_index: { type: "integer" } }, ["conversation_id"]),
    { readOnlyHint: true },
    (a) => ({ body: { conversation_id: a.conversation_id, limit: a.limit, less_than_index: a.less_than_index } })],
  ["hevy_coach_message_send", "Coach: send a chat message (POST /coach/message).", "POST", "/coach/message",
    S({ body: { type: "object" } }, ["body"]), {}, (a) => ({ body: a.body })],
  ["hevy_coach_conversation_create", "Coach: create a conversation with a user (POST /coach/create_conversation).", "POST", "/coach/create_conversation",
    S({ conversation_user_ids: { type: "array", items: { type: "string" } } }, ["conversation_user_ids"]), {},
    (a) => ({ body: { conversation_user_ids: a.conversation_user_ids } })],

  // ---- Generic ----
  ["hevy_request",
    "Call ANY discovered Hevy endpoint (raw). Auth auto-routed: paths starting with /v1/ use the public api-key; everything else uses the session token. Use hevy_search_endpoints to find paths. Examples: {method:'GET', path:'/coach/get_coachs_clients'}, {method:'GET', path:'/hevy_trainer/v3/program', query:{client_program_updated_at:'...'}}.",
    null, null,
    S({
      method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"] },
      path: { type: "string" },
      query: { type: "object" },
      body: { type: ["object", "array", "string"] },
      pathParams: { type: "object" },
    }, ["method", "path"]),
    { openWorldHint: true },
    (a) => ({ raw: a })],
  ["hevy_search_endpoints",
    "Search the full reverse-engineered Hevy endpoint inventory (328 entries: trainer, coach, mobile private, public v1). Results include request body/query shapes where known (top-level for private endpoints, full schema for public API).",
    null, null,
    S({ query: { type: "string" }, group: { type: "string", enum: ["trainer", "coach", "mobile", "public"] }, limit: { type: "integer", default: 30 } }),
    { readOnlyHint: true },
    (a) => ({ search: a })],
  ["hevy_endpoint_schema",
    "Get one endpoint's details: verb, path, body keys, and the extracted request body/query shape (field names, nesting, param references). Call this before writing payloads to POST/PUT endpoints. Example: {verb:'PUT', path:'/v1/routines/{routineId}'}.",
    null, null,
    S({ verb: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"] }, path: { type: "string" } }, ["verb", "path"]),
    { readOnlyHint: true },
    (a) => ({ schema: a })],
  ["hevy_auth_status",
    "Check session/api-key configuration (never returns token values, only presence + expiry).",
    null, null, S(), { readOnlyHint: true }, () => ({ authStatus: true })],
  ["hevy_refresh_session",
    "Force-refresh the Hevy session tokens now (POST /auth/refresh_token) and report the new status.",
    null, null, S(), {}, () => ({ refresh: true })],
];

function toToolDef([name, description, method, p, schema, annotations]) {
  return { name, description, inputSchema: schema, annotations: { openWorldHint: true, ...annotations } };
}

function allInventory() {
  const rows = [];
  for (const [group, list] of Object.entries(INVENTORY.groups)) {
    for (const e of list) rows.push({ group, ...e });
  }
  return rows;
}

// optional: expose every endpoint as a tool (HEVY_TOOLS=all)
function generatedTools() {
  const slug = (s) => s.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return allInventory().map((e) => {
    const params = [...new Set((e.path.match(/\{(\w+)\}/g) || []).map((x) => x.slice(1, -1)))];
    const props = {};
    for (const pm of params) props[pm] = { type: "string" };
    props.query = { type: "object" };
    props.body = { type: ["object", "array"] };
    return {
      name: `hevy_${slug(e.verb + "_" + e.path)}`,
      description: `[${e.group}] ${e.verb} ${e.path}${e.name ? ` (${e.name})` : ""}`,
      inputSchema: S(props),
      annotations: { readOnlyHint: e.verb === "GET", openWorldHint: true },
      spec: { method: e.verb, path: e.path, params },
    };
  });
}
const GENERATED = EXPOSE_ALL ? generatedTools() : [];
const GENERATED_BY_NAME = new Map(GENERATED.map((g) => [g.name, g]));

const server = new Server(
  { name: "hevy", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...TOOLS.map(toToolDef), ...GENERATED.map(({ spec, ...t }) => t)],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === "hevy_request") {
      const { method, path: p, query, body, pathParams } = args;
      const r = await hevyRequest({ method, path: p, query, body, pathParams });
      return ok(r);
    }
    if (name === "hevy_search_endpoints") {
      const { query, group, limit = 30 } = args;
      let rows = allInventory();
      if (group) rows = rows.filter((r) => r.group === group);
      if (query) {
        const q = query.toLowerCase();
        rows = rows.filter((r) => (`${r.verb} ${r.path} ${r.name || ""}`).toLowerCase().includes(q));
      }
      return ok({ total: rows.length, results: rows.slice(0, limit) });
    }
    if (name === "hevy_endpoint_schema") {
      const { verb, path: p } = args;
      const wanted = `${verb.toUpperCase()} ${p}`;
      let row = null;
      for (const [group, list] of Object.entries(INVENTORY.groups)) {
        for (const e of list) {
          if (`${e.verb} ${e.path}` === wanted || `${e.verb} ${e.path.replace(/\/$/, "")}` === wanted.replace(/\/$/, "")) {
            row = { group, ...e };
            break;
          }
        }
        if (row) break;
      }
      if (!row) {
        return { isError: true, content: [{ type: "text", text: `Not found: ${wanted}. Use hevy_search_endpoints to discover paths.` }] };
      }
      return ok({ ...row, modelsHint: INVENTORY.models ? `${Object.keys(INVENTORY.models).length} shared schemas (see hevy://endpoints models)` : undefined });
    }
    if (name === "hevy_auth_status") {
      return ok(authStatus());
    }
    if (name === "hevy_refresh_session") {
      return ok(await refreshSession());
    }
    const tool = TOOLS.find((t) => t[0] === name);
    if (tool) {
      const [, , method, p, , , build] = tool;
      const reqSpec = build(args);
      const r = await hevyRequest({ method, path: p, allow404: p === "/hevy_trainer/user_preferences", ...reqSpec });
      return ok(r);
    }
    const gen = GENERATED_BY_NAME.get(name);
    if (gen) {
      const { method, path: p, params } = gen.spec;
      const pathParams = {};
      for (const pm of params) {
        if (args[pm] === undefined) throw new Error(`Missing path param: ${pm}`);
        pathParams[pm] = args[pm];
      }
      const r = await hevyRequest({ method, path: p, pathParams, query: args.query, body: args.body });
      return ok(r);
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${err.message}` }],
    };
  }
});

function ok(r) {
  const d = r && typeof r === "object" && "data" in r ? r.data : r;
  const text = typeof d === "string" ? d : JSON.stringify(d, null, 1) ?? "null";
  return { content: [{ type: "text", text: text.length > 60000 ? text.slice(0, 60000) + "\n... (truncated)" : text }] };
}

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: "hevy://endpoints", name: "Endpoint inventory", description: `All discovered Hevy endpoints (trainer/coach/mobile/public) with request body/query shapes where extracted + ${INVENTORY.models ? Object.keys(INVENTORY.models).length : 0} shared OpenAPI schemas in the models section`, mimeType: "application/json" },
    { uri: "hevy://auth", name: "Auth status", description: "Session token / api key configuration status", mimeType: "application/json" },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const uri = req.params.uri;
  if (uri === "hevy://endpoints") {
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(allInventory(), null, 1) }] };
  }
  if (uri === "hevy://auth") {
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(authStatus(), null, 1) }] };
  }
  throw new Error(`Unknown resource: ${uri}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
