// Demo build only (PUBLIC_OCI_DEMO=1): answers the app's /api/* calls in the browser so the public demo runs
// without AWS. Everything is stored in this visitor's own browser (localStorage); no data leaves the device.
// Scores, the roadmap and progress come from core.ts (identical to the Python engine). Reports for the three
// synthetic samples are the ones Claude wrote in the passing quality-gate run; any other answers get a report
// built by code from the engine's ranking (the same fallback the roadmap uses), labeled as such.
import bank from "../../../../data/questions.json";
import info from "../../../../data/domain_info.json";
import samplesMeta from "../../../../data/samples.json";
import catalogList from "../../../../resources/catalog.json";
import sampleA from "../../../../benchmark/sample_A_answers.json";
import sampleB from "../../../../benchmark/sample_B_answers.json";
import sampleC from "../../../../benchmark/sample_C_answers.json";
import saved from "./sample-reports.json";
import * as C from "./core";

type Json = Record<string, any>;
const BANK = bank as unknown as C.Bank;
const CATALOG = catalogList as unknown as C.CatalogEntry[];
const SAMPLE_ANSWERS: Record<string, Json> = { A: sampleA.answers, B: sampleB.answers, C: sampleC.answers };
const SAMPLES = samplesMeta as unknown as Record<string, Json>;
const REPORTS = (saved as Json).reports as Record<string, { domain_ids: string[]; report: Json }>;

const USERS: Record<string, [string, string]> = { demo: ["demo", "org"], showcase: ["showcase", "org"] };
const PRIORITY_DOMAINS = ["PL", "FR", "FM", "ML"];
const LANGUAGES = ["en", "es"];
const PROGRAM_MODELS = ["Street outreach", "Hospital-based violence intervention", "Mentoring/youth development",
  "Therapy/CBT", "Re-entry support", "Other"];
const STAFF_SIZES = ["1-5", "6-10", "11-20", "21-50", "51+"];
const BUDGETS = ["Under $250K", "$250K to $1M", "$1M to $5M", "Over $5M"];
const RESPONDENT_ROLES = ["Executive director", "Finance lead or bookkeeper", "Board chair or member", "Program director",
  "Other leadership role"];
const STATES: Record<string, string> = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii",
  ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine",
  MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  PR: "Puerto Rico", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };
// Demo steps describe what the demo actually does: no website research, no model call.
const DEMO_STEPS: [string, string][] = [
  ["read", "Reading your answers"], ["score", "Scoring capacity domains"],
  ["library", "Consulting the CVI resource library"],
  ["write", "Writing your recommendations"],
  ["plain", "Checking it reads clearly"],
];
const STEP_MS = 900;
const SHOWCASE = { sample: "A", name: "Jordan Rivera" };

// ---------- storage (this browser only) ----------

const KEY = "oci-demo-v1";
interface Store { user: Json | null; owner: string | null; subs: Record<string, Json>; drafts: Record<string, Json>;
  extra: Record<string, Json> }
function load(): Store {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && typeof s === "object") return { user: null, owner: null, subs: {}, drafts: {}, extra: {}, ...s };
  } catch { /* storage blocked or corrupt: start fresh */ }
  return { user: null, owner: null, subs: {}, drafts: {}, extra: {} };
}
let mem: Store | null = null;
const store = () => (mem ??= load());
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(store())); } catch { /* private mode: keep it in memory */ }
}
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, "0")).join("");

// ---------- responses ----------

class Reply { constructor(public status: number, public body: unknown) {} }
const ok = (body: unknown, status = 200) => new Reply(status, body);
const fail = (error: string, status: number) => new Reply(status, { error });

function needUser() {
  if (!store().user) throw fail("Please sign in.", 401);
  return store().user!;
}

// ---------- reports ----------

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** The report Claude wrote for a synthetic sample, when these are exactly that sample's answers and areas. */
function savedReport(sub: Json): Json | null {
  for (const k of Object.keys(SAMPLE_ANSWERS)) {
    const s = SAMPLE_ANSWERS[k];
    if (Object.keys(sub.answers).every((q) => s[q] === sub.answers[q])) {
      const r = REPORTS[`${k}-${sub.language}`] || REPORTS[`${k}-en`];
      if (r && sameSet(r.domain_ids, sub.domain_ids)) return { ...r.report, demo_source: "claude-sample" };
    }
  }
  return null;
}

/** A report written by code from the engine's own ranking (milestones.engine_report), for any other answers. */
function engineWrittenReport(sub: Json): Json {
  const fb = C.engineReport(sub);
  const withRes = (it: Json) => ({ title: it.title, why: it.why, gap_ids: it.gap_ids, steps: it.steps,
    resource: C.resourceFor([it], CATALOG) });
  const focus = fb.focus.map(withRes);
  const plan = fb.plan.map((it: Json) => ({ ...withRes(it), horizon: it.horizon, owner: it.owner }));
  const ds = [...sub.domains].sort((a: Json, b: Json) => b.score_pct - a.score_pct);
  const best = ds[0], room = ds[ds.length - 1];
  const o = sub.overall;
  const summary = [
    `${sub.org_name} answered ${o.total_questions} statements across ${sub.domains.length} ${sub.domains.length === 1 ? "area" : "areas"}.`,
    `${o.favorable} of them (${o.favorable_pct}%) are already in place.`,
    best ? `Your strongest area is ${best.domain_name}, at the ${best.estimated_stage} stage.` : "",
    room && room !== best ? `The most room to grow is in ${room.domain_name}.` : "",
    o.total_gaps ? `Start with the ${focus.length === 1 ? "priority" : "two priorities"} below, then follow your 12-week roadmap.` :
      "Every statement you answered is already in place. Keep it going and retake the OCI in a year.",
    "In this demo, this report is built by code from your answers. In the full version, Claude writes it.",
  ].filter(Boolean).join(" ");
  const strengths = ds.filter((d: Json) => d.favorable_count > 0).slice(0, 3).map((d: Json) =>
    `${d.domain_name}: ${d.favorable_count} of ${d.total_questions} statements are already in place (${d.estimated_stage}).`);
  const sources: Json[] = [];
  for (const it of [...focus, ...plan]) {
    const res = it.resource;
    if (res && !sources.some((s) => s.url === res.url)) sources.push(res);
  }
  return {
    summary, focus, strengths, plan, sources, reading_grade: null, simplified: false, demo_source: "engine",
    conversation: [
      "Which of these priorities would make the biggest difference for the people we serve this year?",
      "Who on our team owns each step in the first four weeks?",
      "What support would help us move faster, and who could we ask for it?",
    ],
  };
}

/** Steps advance on a short timer after submit, then the report is attached. */
function advance(sub: Json): Json {
  if (sub.status !== "running") return sub;
  const elapsed = Date.now() - (sub.demo_started || 0);
  const pending = sub.steps.filter((s: Json) => s.state !== "done");
  const finished = Math.min(pending.length, Math.floor(elapsed / STEP_MS));
  pending.forEach((s: Json, i: number) => { s.state = i < finished ? "done" : i === finished ? "running" : "pending"; });
  if (finished >= pending.length) {
    sub.report = savedReport(sub) || engineWrittenReport(sub);
    sub.status = "done";
    sub.pdf_kb = null;
    save();
  }
  return sub;
}

function publicSub(sub: Json): Json {
  const { demo_started: _a, demo_owner: _b, roadmap_done: _c, ...rest } = advance(sub);
  return rest;
}

function domainsFor(ids: unknown): C.BankDomain[] {
  const list = Array.isArray(ids) ? ids.filter((i) => typeof i === "string") : [];
  return BANK.domains.filter((d) => list.includes(d.id));
}

function submit(org: Json, answers: Json, domains: C.BankDomain[], profile: string | null) {
  const s = store();
  const now = Date.now();
  const sub = C.buildAssessment(BANK, org, answers, domains, profile, uuid(), C.createdStamp(now), DEMO_STEPS);
  const key = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "org";
  const prev = Object.values(s.subs).filter((p) => p.demo_owner === s.owner && key(p.org_name) === key(sub.org_name))
    .sort((a, b) => b.demo_started - a.demo_started)[0];
  sub.progress = prev ? C.compare(prev, sub) : null;
  sub.demo_started = now;
  sub.demo_owner = s.owner;
  s.subs[sub.id] = sub;
  save();
  return sub.id;
}

function findSub(id: string, owned = false) {
  const sub = store().subs[id];
  if (!sub) throw fail("Report not found.", 404);
  if (owned && sub.demo_owner !== store().owner) throw fail("Only the person who submitted this assessment can do this.", 403);
  return sub;
}

// ---------- roadmap ----------

function roadmapState(sub: Json) {
  const rm = C.buildRoadmap(sub, CATALOG);
  const ids = new Set(rm.weeks.flatMap((w: Json) => w.tasks.map((t: Json) => t.id)));
  const done: Record<string, number> = Object.fromEntries(Object.entries(sub.roadmap_done || {})
    .filter(([k]) => ids.has(k)) as [string, number][]);
  return { rm, done, state: C.progress(rm, done, C.createdMs(sub.created), Date.now()) };
}

// ---------- routes ----------

function clean(o: unknown): Json { return o && typeof o === "object" && !Array.isArray(o) ? (o as Json) : {}; }
const str = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);

function route(method: string, path: string, body: Json): Reply {
  const s = store();
  const p = path.split("?")[0];
  let m: RegExpExecArray | null;

  if (p === "/healthz") return ok("ok");
  if (p === "/login" && method === "POST") {
    const u = USERS[str(body.username, 50)];
    if (!u || body.password !== u[0]) {
      return fail(body.username === "staff"
        ? "The Everytown staff dashboard is not part of this public demo. Sign in with demo / demo."
        : "That username and password did not match. Use demo / demo.", 401);
    }
    s.user = { name: body.username, role: u[1] };
    s.owner = uuid();
    save();
    return ok({ user: s.user });
  }
  if (p === "/logout" && method === "POST") { s.user = null; s.owner = null; save(); return new Reply(204, null); }
  if (p === "/me") return ok({ user: needUser() });
  if (p === "/meta") {
    const user = needUser();
    const names = BANK.stage_names;
    const sa = SAMPLES[SHOWCASE.sample];
    return ok({
      domains: BANK.domains.map((d) => ({ id: d.id, name: d.name, weight: d.weight,
        about: (info as Json).domains[d.id].about, connects: (info as Json).domains[d.id].connects,
        priority: PRIORITY_DOMAINS.includes(d.id),
        questions: d.questions.map((q) => ({ id: q.id, text: q.text, stage: q.stage, stage_name: names[String(q.stage)],
          reverse: q.trigger_on === "yes" })) })),
      stages: [1, 2, 3, 4, 5].map((i) => ({ n: i, name: names[String(i)], description: (info as Json).stage_descriptions[names[String(i)]] })),
      samples: Object.entries(SAMPLES).map(([k, v]) => ({ id: k, name: v.name, summary: v.summary })),
      languages: LANGUAGES, default_domains: PRIORITY_DOMAINS,
      preset: user.name === "showcase" ? { org_name: sa.name, org_url: "", language: "en", domain_ids: [...PRIORITY_DOMAINS],
        answers: {}, org_meta: sa.org_meta, respondent: { ...sa.respondent, name: SHOWCASE.name }, org_links: null } : null,
    });
  }
  if (p === "/org-meta") {
    needUser();
    return ok({ program_models: PROGRAM_MODELS, staff_sizes: STAFF_SIZES, budgets: BUDGETS, respondent_roles: RESPONDENT_ROLES,
      states: Object.entries(STATES).sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => ({ code, name })) });
  }

  if (p === "/assessments" && method === "POST") {
    needUser();
    const errors: Json = {};
    const name = str(body.org_name, 200);
    let url = str(body.org_url, 500);
    if (url && !url.includes("://")) url = "https://" + url;
    const domains = domainsFor(body.domain_ids);
    const answers = clean(body.answers);
    if (!name) errors.org_name = "Enter your organization's name.";
    if (url && !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(url)) errors.org_url = "Enter a web address like https://example.org, or leave it blank.";
    if (!domains.length) errors.domain_ids = "Choose at least one area to assess.";
    const r = clean(body.respondent);
    const respondent = { name: str(r.name, 100) || null, title: str(r.title, 100) || null, role: r.role || null };
    if (respondent.role && !RESPONDENT_ROLES.includes(respondent.role)) errors.respondent_role = "Choose the role that fits you best.";
    if (!respondent.title) errors.respondent_title = "Enter your job title.";
    if (!respondent.name) errors.respondent_name = "Enter your name.";
    const missing = domains.flatMap((d) => d.questions.filter((q) => !["yes", "no"].includes(answers[q.id])).map((q) => q.id));
    if (Object.keys(errors).length || missing.length) return ok({ errors, missing }, 400);
    const org = { org_name: name, org_url: url, language: LANGUAGES.includes(body.language) ? body.language : "en",
      org_meta: body.org_meta ?? null, respondent, org_links: url ? { website: url, social: [] } : null,
      answered_by: respondent.role ? Object.fromEntries(domains.map((d) => [d.id, respondent.role])) : null };
    const picked = Object.fromEntries(domains.flatMap((d) => d.questions.map((q) => [q.id, answers[q.id]])));
    return ok({ id: submit(org, picked, domains, null) }, 201);
  }
  if (p === "/demo" && method === "POST") {
    needUser();
    const sample = SAMPLES[body.sample];
    if (!sample) return fail("Unknown sample.", 400);
    const domains = domainsFor(body.domain_ids).length ? domainsFor(body.domain_ids) : domainsFor(PRIORITY_DOMAINS);
    const respondent = sample.respondent ? { ...sample.respondent } : null;
    const org = { org_name: sample.name, org_url: "", language: LANGUAGES.includes(body.language) ? body.language : "en",
      org_meta: sample.org_meta ?? null, respondent,
      answered_by: respondent ? Object.fromEntries(domains.map((d) => [d.id, respondent.role])) : null };
    const answers = Object.fromEntries(domains.flatMap((d) => d.questions.map((q) => [q.id, SAMPLE_ANSWERS[body.sample][q.id]])));
    return ok({ id: submit(org, answers, domains, sample.profile) }, 201);
  }
  if ((m = /^\/assessments\/([^/]+)$/.exec(p))) { needUser(); return ok(publicSub(findSub(decodeURIComponent(m[1])))); }
  if ((m = /^\/assessments\/([^/]+)\/status$/.exec(p))) {
    needUser();
    const sub = advance(findSub(decodeURIComponent(m[1])));
    return ok({ status: sub.status, steps: sub.steps, error: sub.error });
  }
  if ((m = /^\/assessments\/([^/]+)\/retry$/.exec(p))) { needUser(); return ok({ status: advance(findSub(decodeURIComponent(m[1]))).status }, 202); }
  if ((m = /^\/assessments\/([^/]+)\/support$/.exec(p)) && method === "POST") {
    needUser();
    const sub = findSub(decodeURIComponent(m[1]), true);
    const chosen = Array.isArray(body.domain_ids) ? body.domain_ids : [];
    const ids = sub.domain_ids.filter((d: string) => chosen.includes(d));
    if (!ids.length) return fail("Choose at least one area you would like support with.", 400);
    sub.support = { domain_ids: ids, requested_at: C.createdStamp(Date.now()) };
    save();
    return ok({ support: sub.support });
  }
  if ((m = /^\/assessments\/([^/]+)\/peer-request$/.exec(p)) && method === "POST") {
    needUser();
    const sub = findSub(decodeURIComponent(m[1]), true);
    sub.peer_request ??= { requested_at: C.createdStamp(Date.now()) };
    save();
    return ok({ peer_request: sub.peer_request });
  }
  if ((m = /^\/assessments\/([^/]+)\/report\.pdf$/.exec(p))) {
    return fail("PDF downloads need the full version. In this demo, use your browser's Print and choose Save as PDF.", 501);
  }
  if ((m = /^\/assessments\/([^/]+)\/ask(\/new)?$/.exec(p))) {
    needUser();
    findSub(decodeURIComponent(m[1]));
    if (method === "GET") return ok({ messages: [], remaining: 5 });
    if (m[2]) return ok({ messages: [], remaining: 5 });
    return fail("The chat coach runs on Claude in the full version. This demo does not send questions to an AI model.", 503);
  }
  if ((m = /^\/assessments\/([^/]+)\/feedback$/.exec(p))) {
    needUser();
    const sub = findSub(decodeURIComponent(m[1]));
    sub.feedback ??= [];
    if (method === "POST") {
      if (typeof body.section !== "string" || typeof body.helpful !== "boolean") return fail("Say whether this part helped.", 400);
      sub.feedback = sub.feedback.filter((f: Json) => f.section !== body.section);
      sub.feedback.push({ section: body.section, helpful: body.helpful,
        comment: typeof body.comment === "string" && body.comment.trim() ? body.comment.trim().slice(0, 1000) : null,
        created: C.createdStamp(Date.now()) });
      save();
      return ok({ feedback: sub.feedback });
    }
    return ok({ feedback: sub.feedback, review: null });
  }
  if ((m = /^\/assessments\/([^/]+)\/optin$/.exec(p))) {
    needUser();
    const sub = findSub(decodeURIComponent(m[1]));
    if (method === "POST") {
      if (typeof body.training !== "boolean" || typeof body.updates !== "boolean") return fail("Choose yes or no for trainings and updates.", 400);
      if (!body.training && !body.updates) { sub.optin = null; save(); return ok({ optin: null }); }
      const email = str(body.email, 254);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter an email address, like name@example.org.", 400);
      sub.optin = { training: body.training, updates: body.updates, name: str(body.name, 100) || null, email,
        updated: C.createdStamp(Date.now()) };
      save();
      return ok({ optin: sub.optin });
    }
    return ok({ optin: sub.optin ?? null });
  }
  if ((m = /^\/assessments\/([^/]+)\/roadmap$/.exec(p))) {
    needUser();
    const sub = advance(findSub(decodeURIComponent(m[1]), true));
    if (sub.status === "running") return fail("Your roadmap will be ready when your report is.", 409);
    return ok(C.roadmapView(sub, roadmapState(sub).state));
  }
  if ((m = /^\/assessments\/([^/]+)\/roadmap\/tasks\/([^/]+)$/.exec(p)) && method === "POST") {
    needUser();
    const sub = advance(findSub(decodeURIComponent(m[1]), true));
    if (typeof body.done !== "boolean") return fail("Send done: true or false.", 400);
    const taskId = decodeURIComponent(m[2]);
    const { rm, done, state: before } = roadmapState(sub);
    const week = before.weeks.find((w: Json) => w.tasks.some((t: Json) => t.id === taskId));
    if (!week) return fail("Step not found.", 404);
    if (week.state === "locked") return fail(`This week is not open yet. It opens on ${new Date(week.unlocks_at).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}.`, 403);
    const now = Date.now();
    if (body.done) done[taskId] ??= now; else delete done[taskId];
    sub.roadmap_done = done;
    save();
    const after = C.progress(rm, done, C.createdMs(sub.created), now);
    const was: Json = Object.fromEntries(before.weeks.map((w: Json) => [w.n, w.state]));
    const had = new Set(before.badges.filter((b: Json) => b.earned).map((b: Json) => b.id));
    const celebrate = {
      weeks: after.weeks.filter((w: Json) => w.state === "done" && was[w.n] !== "done").map((w: Json) => w.n),
      opened: after.weeks.filter((w: Json) => w.state !== "locked" && was[w.n] === "locked").map((w: Json) => w.n),
      points: after.points - before.points,
      badges: after.badges.filter((b: Json) => b.earned && !had.has(b.id)).map((b: Json) => b.name),
    };
    return ok({ ...C.roadmapView(sub, after), celebrate });
  }
  if (/^\/assessments\/[^/]+\/(roadmap\/week\/\d+\.pdf|audio\/.+)$/.test(p)) {
    return fail("This needs the full version. The demo runs in your browser without AWS.", 501);
  }

  if (p === "/drafts" && method === "POST") {
    needUser();
    const t = token();
    s.drafts[t] = { data: clean(body.data), owner: s.owner };
    save();
    return ok({ token: t }, 201);
  }
  if ((m = /^\/drafts\/([^/]+)\/share$/.exec(p))) {
    return fail("Sharing an area with a teammate needs the full version. In this demo, everything stays in this browser.", 501);
  }
  if ((m = /^\/drafts\/([^/]+)$/.exec(p))) {
    needUser();
    const d = s.drafts[decodeURIComponent(m[1])];
    if (!d) return fail("We could not find that saved assessment. Check the link and try again.", 404);
    if (method === "POST") { d.data = { ...d.data, ...clean(body.data) }; save(); }
    return ok({ data: d.data, area: null });
  }

  if (p.startsWith("/staff")) return fail("The Everytown staff dashboard is not part of this public demo.", 403);
  return fail("Not found.", 404);
}

/** Same contract as fetch-based request() in api.ts: resolves to {status, body}. */
export async function demoRequest(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  await new Promise((r) => setTimeout(r, 120)); // let the page paint its loading states, as with a network call
  try {
    const r = route(method, path, clean(body));
    return { status: r.status, body: r.body };
  } catch (e) {
    if (e instanceof Reply) return { status: e.status, body: e.body };
    console.error("[oci-demo]", e);
    return { status: 500, body: { error: "Something went wrong in the demo. Reload the page to try again." } };
  }
}
