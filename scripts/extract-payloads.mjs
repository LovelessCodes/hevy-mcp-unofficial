// Extracts request-body / query skeletons for endpoints.
// Source 1: notes/hevy_bundle.hasm (mobile Hermes disassembly) via a mini-VM over registers.
// (coach JS + OpenAPI extraction can be added on top; they write the same fields.)
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const project = path.resolve(here, "..");
const workdir = path.resolve(project, "..");

const HASM = process.env.HEVY_HASM || path.join(workdir, "notes/hevy_bundle.hasm");
const endpointsPath = path.join(project, "src/endpoints.json");

const VERBS = ["get", "post", "put", "delete", "patch"];
const fnRe = /=> \[Function #(\d+) "([^"]*)" of \d+ bytes\]/;
const strCommentRe = /# String: '((?:[^'\\]|\\.)*)' \((?:String|Identifier)\)/;
const instructionRe = /=> [0-9a-f]+: <(\w+)>:/;

function parseLiteralish(s) {
  if (!s) return null;
  const cleaned = s.replace(/'/g, '"').replace(/\bundefined\b/g, "null").replace(/\bNaN\b/g, "null");
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function loadFunctionBlocks() {
  const text = fs.readFileSync(HASM, "utf8");
  const blocks = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const m = fnRe.exec(line);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { id: m[1], name: m[2], body: [] };
      continue;
    }
    if (line.startsWith("===============")) {
      if (cur) blocks.push(cur);
      cur = null;
      continue;
    }
    if (cur) cur.body.push(line);
  }
  if (cur) blocks.push(cur);
  return blocks;
}

function shape(regs, value) {
  if (!value) return "<unknown>";
  switch (value.kind) {
    case "const":
      if (value.value === null) return null;
      if (typeof value.value === "string") return value.value.length > 48 ? "<string>" : value.value;
      return value.value;
    case "param":
      return `<param:${value.index}>`;
    case "member":
      return `${value.ofParam !== undefined ? `<param:${value.ofParam}>` : "<this>"}.${value.key}`;
    case "object":
      return value.fields;
    case "array":
      return value.items.length ? value.items.map((f) => f) : value.literal ?? ["<item>"];
    default:
      return "<unknown>";
  }
}

function analyzeBlock(block) {
  const regs = new Map(); // reg -> descriptor
  let verbReg = null;
  let verbName = null;
  const calls = [];

  const trace = process.env.DEBUG_BLOCK && process.env.DEBUG_BLOCK === block.name;
  for (const ln of block.body) {
    const im = instructionRe.exec(ln);
    if (!im) continue;
    const instr = im[1];
    const strm = strCommentRe.exec(ln);
    const str = strm ? strm[1] : null;
    const regNums = [...ln.matchAll(/Reg8: (\d+)/g)].map((m) => +m[1]);
    const reg0 = regNums[0];
    if (trace) console.log("TRACE", instr, "regs=" + regNums.join(","), "str=", JSON.stringify(str));

    switch (instr) {
      case "GetById":
      case "GetByIdShort":
      case "TryGetById": {
        if (str && VERBS.includes(str)) {
          verbReg = reg0;
          verbName = str;
        } else if (str) {
          regs.set(reg0, { kind: "member", key: str, ofParam: undefined });
        }
        break;
      }
      case "LoadParam": {
        regs.set(reg0, { kind: "param", index: +(ln.match(/UInt8: (\d+)/)?.[1] ?? -1) });
        break;
      }
      case "LoadConstString":
        regs.set(reg0, { kind: "const", value: str });
        break;
      case "LoadConstTrue":
        regs.set(reg0, { kind: "const", value: true });
        break;
      case "LoadConstFalse":
        regs.set(reg0, { kind: "const", value: false });
        break;
      case "LoadConstNull":
      case "LoadConstUndefined":
        regs.set(reg0, { kind: "const", value: null });
        break;
      case "LoadConstZero":
        regs.set(reg0, { kind: "const", value: 0 });
        break;
      case "LoadConstUInt8":
      case "LoadConstInt":
        regs.set(reg0, { kind: "const", value: +(ln.match(/(?:UInt8|Imm32): (-?\d+)/)?.[1] ?? 0) });
        break;
      case "NewObject":
        regs.set(reg0, { kind: "object", fields: {} });
        break;
      case "NewObjectWithBuffer": {
        const lit = parseLiteralish(ln.slice(ln.indexOf("# Object:") === -1 ? 0 : ln.indexOf("# Object:") + 9));
        regs.set(reg0, { kind: "object", fields: lit && typeof lit === "object" && !Array.isArray(lit) ? lit : {} });
        break;
      }
      case "NewArray":
        regs.set(reg0, { kind: "array", items: [], literal: null });
        break;
      case "NewArrayWithBuffer":
      case "NewArrayWithBufferLong": {
        const lit = parseLiteralish(ln.slice(ln.indexOf("# Array:") === -1 ? 0 : ln.indexOf("# Array:") + 8));
        regs.set(reg0, { kind: "array", items: [], literal: Array.isArray(lit) ? lit : null });
        break;
      }
      case "Mov":
        regs.set(reg0, regs.get(regNums[1]) ?? { kind: "unknown" });
        break;
      case "PutNewOwnById":
      case "PutNewOwnByIdShort": {
        const objReg = regNums[0];
        const valReg = regNums[1];
        const obj = regs.get(objReg);
        if (obj?.kind === "object" && str) obj.fields[str] = shape(regs, regs.get(valReg));
        break;
      }
      case "PutOwnByIndex": {
        const obj = regs.get(regNums[0]);
        if (obj?.kind === "array") obj.items.push(shape(regs, regs.get(regNums[1])));
        break;
      }
      default:
        if (instr.startsWith("Call")) {
          calls.push({ operandRegs: regNums, verbReg });
        } else if (instr.startsWith("Get") || instr.startsWith("Load") || instr.startsWith("Create")) {
          // unknown result
          if (reg0 !== undefined) regs.set(reg0, { kind: "unknown" });
        }
    }
  }

  const out = [];
  if (trace) console.log("TRACE calls:", calls.length, "verbReg:", verbReg, JSON.stringify(calls.map((c) => c.operandRegs)));
  for (const c of calls) {
    if (verbReg === null || !c.operandRegs.includes(verbReg)) continue;
    const resolved = c.operandRegs.map((r) => regs.get(r));
    if (trace) console.log("TRACE resolved:", JSON.stringify(resolved.map((v) => v?.kind)));
    const pathIdx = resolved.findIndex(
      (v) => v?.kind === "const" && typeof v.value === "string" && /^[a-z_/]/.test(v.value) && !VERBS.includes(v.value) && !v.value.startsWith("http"),
    );
    if (pathIdx === -1) continue;
    const rawPath = resolved[pathIdx].value;
    const after = resolved.slice(pathIdx + 1).filter((v) => v && (v.kind === "object" || v.kind === "array" || v.kind === "param"));
    const payload = after.length ? after[after.length - 1] : null;
    out.push({ verb: verbName.toUpperCase(), path: rawPath, payload: payload ? shape(regs, payload) : null });
  }
  if (out.length && process.env.DEBUG_CALLS) {
    console.log(`[block #${block.id} ${block.name}]`, JSON.stringify(out).slice(0, 300));
  }
  return out;
}

function main() {
  const inv = JSON.parse(fs.readFileSync(endpointsPath, "utf8"));
  for (const list of Object.values(inv.groups)) {
    for (const e of list) {
      delete e.bodyShape;
      delete e.queryShape;
      delete e.bodySource;
      delete e.querySource;
    }
  }

  const byPath = new Map();
  for (const list of Object.values(inv.groups)) {
    for (const e of list) byPath.set(`${e.verb} ${e.path}`, e);
  }

  if (!fs.existsSync(HASM)) {
    console.log(`hasm not found at ${HASM} — skipping mobile extraction`);
  } else {
    const blocks = loadFunctionBlocks();
    console.log(`function blocks: ${blocks.length}`);
    let applied = 0;
    let found = 0;
    for (const b of blocks) {
      const calls = analyzeBlock(b);
      if (calls.length) found += calls.length;
      for (const call of calls) {
        const norm = "/" + call.path.replace(/^\/+/, "");
        const candidates = [`${call.verb} ${norm}`, `${call.verb} ${norm}/`];
        let target = candidates.map((c) => byPath.get(c)).find(Boolean);
        if (!target) {
          for (const [k, e] of byPath) {
            const sp = k.indexOf(" ");
            const v = k.slice(0, sp);
            const p = k.slice(sp + 1);
            if (v === call.verb && p.startsWith(norm)) {
              target = e;
              break;
            }
          }
        }
        if (!target) continue;
        if (!call.payload) { if(process.env.DEBUG_CALLS) console.log("  no payload:", call.verb, call.path); continue; }
        const field = call.verb === "GET" ? "queryShape" : "bodyShape";
        if (target[field]) continue;
        target[field] = call.payload;
        target[`${field === "bodyShape" ? "body" : "query"}Source`] = `hermes:${b.name || "#" + b.id}`;
        if (field === "bodyShape" && call.payload && typeof call.payload === "object" && !Array.isArray(call.payload)) {
          target.bodyKeys = Object.keys(call.payload);
        }
        applied++;
      }
    }
    console.log(`calls found: ${found}, shapes applied: ${applied}`);
  }

  let write = 0;
  let shaped = 0;
  for (const list of Object.values(inv.groups)) {
    for (const e of list) {
      if (["POST", "PUT", "PATCH"].includes(e.verb)) {
        write++;
        if (e.bodyShape) shaped++;
      }
    }
  }
  console.log(`write endpoints: ${write}, with body shape: ${shaped}`);
  fs.writeFileSync(endpointsPath, JSON.stringify(inv, null, 1));
  console.log(`wrote ${endpointsPath}`);
}

main();

export { loadFunctionBlocks, analyzeBlock };
