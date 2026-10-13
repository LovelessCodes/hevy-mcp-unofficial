// Builds src/endpoints.json from the reverse-engineering artifacts.
// Sources:
//   - ../recon/web/coach_api_full.txt        (Hevy Coach web app client, 124 methods)
//   - src/endpoints_mobile.json              (mobile app disassembly extraction, 176 endpoints)
//   - hand-curated trainer/public entries
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const out = path.resolve(here, "..", "src", "endpoints.json");

const norm = (p) => (p.startsWith("/") ? p : "/" + p);

// ---------- coach (web app) ----------
const coachLines = fs.readFileSync(path.join(here, "..", "src", "sources", "coach_api_full.txt"), "utf8").split("\n").filter(Boolean);
const coach = [];
for (const line of coachLines) {
  const m = line.match(/^([A-Za-z0-9_]+)\((.*?)\) \[(GET|POST|PUT|DELETE|PATCH)\] (.*)$/);
  if (!m) continue;
  const [, name, args, verb, expr] = m;
  // path: first quoted string
  const pm = expr.match(/"([^"]*)"/);
  if (!pm) continue;
  let p = norm(pm[1]);
  const concats = [...expr.matchAll(/\.concat\(([^)]*)\)/g)];
  const params = concats.map((c) => c[1].replace(/\s+/g, "")).filter(Boolean);
  // body keys: last {..} object literal in expr
  const bm = [...expr.matchAll(/\{([^{}]*)\}/g)].pop();
  const bodyKeys = bm ? bm[1].split(",").map((s) => s.split(":")[0].trim()).filter((s) => /^[a-zA-Z_]\w*$/.test(s)) : [];
  coach.push({ source: "coach", name, verb, path: p, params, bodyKeys, raw: expr.slice(0, 200) });
}

// ---------- mobile (disassembly) ----------
const mobile = JSON.parse(fs.readFileSync(path.resolve(here, "..", "src", "endpoints_mobile.json"), "utf8"))
  .map((e) => ({ source: "mobile", name: e.function || "", verb: e.verb, path: norm(e.path), params: [], bodyKeys: e.keys || [] }));

// ---------- trainer (hand, verified live) ----------
const trainer = [
  { source: "trainer", name: "getTrainerProgram", verb: "GET", path: "/hevy_trainer/v3/program", params: [], query: ["client_program_updated_at", "client_next_workout_updated_at"], bodyKeys: [] },
  { source: "trainer", name: "postTrainerProgram", verb: "POST", path: "/hevy_trainer/v3/program", params: [], bodyKeys: ["program", "deleteActiveProgram"] },
  { source: "trainer", name: "updateTrainerProgram", verb: "PUT", path: "/hevy_trainer/v3/program", params: [], bodyKeys: ["program"] },
  { source: "trainer", name: "deleteTrainerProgram", verb: "DELETE", path: "/hevy_trainer/program", params: [], bodyKeys: [] },
  { source: "trainer", name: "migrateTrainerToV3", verb: "POST", path: "/hevy_trainer/v3/migrate", params: [], bodyKeys: [] },
  { source: "trainer", name: "getTrainerUserPreferences", verb: "GET", path: "/hevy_trainer/user_preferences", params: [], bodyKeys: [] },
  { source: "trainer", name: "postTrainerUserPreferences", verb: "POST", path: "/hevy_trainer/user_preferences", params: [], bodyKeys: [] },
  { source: "trainer", name: "getHevyTrainerProgramLegacy", verb: "GET", path: "/hevy_trainer/program", params: [], bodyKeys: [] },
  { source: "trainer", name: "postUserTrainingIntent", verb: "POST", path: "/user_training_intent", params: [], bodyKeys: [] },
];

// ---------- public API (/v1, api-key auth) ----------
const pub = [
  { source: "public", name: "getUserInfo", verb: "GET", path: "/v1/user/info" },
  { source: "public", name: "listWorkouts", verb: "GET", path: "/v1/workouts", query: ["page", "pageSize"] },
  { source: "public", name: "getWorkoutCount", verb: "GET", path: "/v1/workouts/count" },
  { source: "public", name: "getWorkout", verb: "GET", path: "/v1/workouts/{workoutId}" },
  { source: "public", name: "createWorkout", verb: "POST", path: "/v1/workouts" },
  { source: "public", name: "updateWorkout", verb: "PUT", path: "/v1/workouts/{workoutId}" },
  { source: "public", name: "getWorkoutEvents", verb: "GET", path: "/v1/workouts/events", query: ["since", "page", "pageSize"] },
  { source: "public", name: "listRoutines", verb: "GET", path: "/v1/routines", query: ["page", "pageSize"] },
  { source: "public", name: "getRoutine", verb: "GET", path: "/v1/routines/{routineId}" },
  { source: "public", name: "createRoutine", verb: "POST", path: "/v1/routines" },
  { source: "public", name: "updateRoutine", verb: "PUT", path: "/v1/routines/{routineId}" },
  { source: "public", name: "listExerciseTemplates", verb: "GET", path: "/v1/exercise_templates", query: ["page", "pageSize"] },
  { source: "public", name: "getExerciseTemplate", verb: "GET", path: "/v1/exercise_templates/{exerciseTemplateId}" },
  { source: "public", name: "listRoutineFolders", verb: "GET", path: "/v1/routine_folders", query: ["page", "pageSize"] },
  { source: "public", name: "getExerciseHistory", verb: "GET", path: "/v1/exercise_history/{exerciseTemplateId}", query: ["start_date", "end_date"] },
  { source: "public", name: "listBodyMeasurements", verb: "GET", path: "/v1/body_measurements", query: ["page", "pageSize"] },
];

const endpoints = { generatedAt: new Date().toISOString(), groups: { trainer, public: pub, coach, mobile } };
fs.writeFileSync(out, JSON.stringify(endpoints, null, 1));
const count = (a) => a.length;
console.log(`wrote ${out}`);
console.log(`trainer=${count(trainer)} public=${count(pub)} coach=${count(coach)} mobile=${count(mobile)} total=${count(trainer) + count(pub) + count(coach) + count(mobile)}`);
