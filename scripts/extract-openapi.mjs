// Pulls request/response schemas from Hevy's official OpenAPI (swagger-ui-init.js)
// and attaches them to the public /v1 endpoints + a shared `models` section.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const project = path.resolve(here, "..");
const endpointsPath = path.join(project, "src/endpoints.json");

function extractJsonObject(text, startMarker) {
  const idx = text.indexOf(startMarker);
  if (idx === -1) throw new Error(`marker not found: ${startMarker}`);
  const braceStart = text.indexOf("{", idx);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(braceStart, i + 1));
    }
  }
  throw new Error("unbalanced object");
}

function resolveRef(doc, ref) {
  const parts = ref.replace(/^#\//, "").split("/");
  let cur = doc;
  for (const p of parts) cur = cur[p];
  return cur;
}

function skeleton(schema, doc, depth = 0, seen = new Set()) {
  if (!schema || depth > 8) return "<deep>";
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return "<recursive>";
    seen.add(schema.$ref);
    const resolved = resolveRef(doc, schema.$ref);
    return skeleton(resolved, doc, depth + 1, seen);
  }
  if (schema.oneOf || schema.anyOf || schema.allOf) {
    const variants = schema.oneOf ?? schema.anyOf ?? schema.allOf;
    return variants.length === 1 ? skeleton(variants[0], doc, depth + 1, seen) : variants.map((v) => skeleton(v, doc, depth + 1, seen));
  }
  switch (schema.type) {
    case "object": {
      const out = {};
      const props = schema.properties ?? {};
      for (const [k, v] of Object.entries(props)) out[k] = skeleton(v, doc, depth + 1, seen);
      if (schema.additionalProperties && !Object.keys(out).length) return { "<key>": skeleton(schema.additionalProperties === true ? {} : schema.additionalProperties, doc, depth + 1, seen) };
      return out;
    }
    case "array":
      return [skeleton(schema.items ?? {}, doc, depth, seen)];
    case "string":
      if (schema.enum) return schema.enum.length === 1 ? schema.enum[0] : schema.enum;
      if (schema.format === "date-time") return "<ISO8601>";
      if (schema.format === "uuid") return "<uuid>";
      if (schema.format === "date") return "<YYYY-MM-DD>";
      return schema.example ?? "<string>";
    case "integer":
    case "number":
      return schema.enum ?? (schema.example ?? 0);
    case "boolean":
      return schema.example ?? true;
    case "null":
      return null;
    default:
      if (schema.enum) return schema.enum;
      return "<any>";
  }
}

async function main() {
  const res = await fetch("https://api.hevyapp.com/docs/swagger-ui-init.js");
  const text = await res.text();
  const doc = extractJsonObject(text, '"swaggerDoc"');
  console.log(`openapi paths: ${Object.keys(doc.paths).length}`);

  const inv = JSON.parse(fs.readFileSync(endpointsPath, "utf8"));

  // shared models
  const models = {};
  for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
    models[name] = skeleton(schema, doc);
  }
  inv.models = models;
  inv.modelsSource = "https://api.hevyapp.com/docs (OpenAPI 0.0.1)";

  let applied = 0;
  for (const list of Object.values(inv.groups)) {
    for (const e of list) {
      if (!e.path.startsWith("/v1/")) continue;
      const item = doc.paths[e.path]?.[e.verb.toLowerCase()];
      if (!item) continue;
      const bodySchema = item.requestBody?.content?.["application/json"]?.schema;
      if (bodySchema) {
        e.bodyShape = skeleton(bodySchema, doc);
        e.bodySource = "openapi";
      }
      const params = item.parameters ?? [];
      const q = params.filter((p) => p.in === "query");
      if (q.length) e.queryShape = Object.fromEntries(q.map((p) => [p.name, p.schema?.type === "integer" ? 0 : "<string>"]));
      applied++;
    }
  }
  console.log(`public endpoints annotated: ${applied}`);
  fs.writeFileSync(endpointsPath, JSON.stringify(inv, null, 1));
  console.log(`wrote ${endpointsPath}`);
}

main().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
