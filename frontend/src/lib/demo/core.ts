// Demo build only (PUBLIC_OCI_DEMO=1): the deterministic parts of the API, ported line for line from
// engine/scoring.py, app.build_assessment / compare, pipeline.choose_focus and features/milestones.py.
// No model calls. Checked identical to the Python originals (assessment, roadmap, progress) on the three
// benchmark samples and 20 random answer sets before release.

type Json = Record<string, any>;

export interface BankQuestion { id: string; text: string; stage: number; trigger_on: string; next_steps: string[] }
export interface BankDomain { id: string; name: string; weight: number; questions: BankQuestion[] }
export interface Bank { domains: BankDomain[]; stage_names: Record<string, string>; stage_weights: Record<string, number> }
export interface CatalogEntry { id: string; title: string; url: string; domains?: string[] }

/** Python's round(x, n): round half to even on the exact binary value, as CPython does. */
export function pyRound(x: number, n = 0): number {
  if (!Number.isFinite(x)) return x;
  const neg = x < 0;
  const ax = Math.abs(x);
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, ax);
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp: number;
  if (expBits === 0) exp = -1074; else { mant |= 1n << 52n; exp = expBits - 1075; }
  // ax = mant * 2^exp exactly; scale by 10^n and round half-even to an integer q.
  let num = mant * 10n ** BigInt(Math.max(n, 0));
  let den = 1n;
  if (n < 0) den *= 10n ** BigInt(-n);
  if (exp >= 0) num <<= BigInt(exp); else den <<= BigInt(-exp);
  let q = num / den;
  const r2 = (num % den) * 2n;
  if (r2 > den || (r2 === den && q % 2n === 1n)) q += 1n;
  const out = n >= 0 ? Number(`${q}e-${n}`) : Number(q) * 10 ** -n;
  return neg ? -out : out;
}

const isGap = (answer: string, trigger: string) => answer === trigger;
const ans = (answers: Json, id: string) => String(answers[id] ?? "").toLowerCase();

/** engine/scoring.py calculate_recommendations, plus format as app.build_assessment stores it. */
export function calculateRecommendations(answers: Json, domains: BankDomain[], stageWeights: Json, stageNames: Json) {
  const domainGaps: Record<string, number> = {};
  const domainTotals: Record<string, number> = {};
  for (const d of domains) {
    let gaps = 0;
    for (const q of d.questions) if (isGap(ans(answers, q.id), q.trigger_on)) gaps += 1;
    domainGaps[d.id] = gaps;
    domainTotals[d.id] = d.questions.length;
  }
  const all: Json[] = [];
  for (const d of domains) {
    const dWeight = d.weight ?? 1.0;
    const bonus = 1.0 + domainGaps[d.id] / Math.max(domainTotals[d.id], 1);
    for (const q of d.questions) {
      if (!isGap(ans(answers, q.id), q.trigger_on)) continue;
      const sWeight = stageWeights[String(q.stage)] ?? 1;
      const score = sWeight * dWeight * bonus;
      all.push({
        question_id: q.id, domain_id: d.id, domain_name: d.name, stage: q.stage,
        stage_name: stageNames[String(q.stage)] ?? "Unknown", question_text: q.text, next_steps: q.next_steps,
        score: pyRound(score, 2), priority: "",
      });
    }
  }
  if (all.length) {
    // Python's sort is stable, as is Array.prototype.sort.
    all.sort((a, b) => b.score - a.score);
    const n = all.length;
    all.forEach((r, i) => {
      const pct = i / n;
      r.priority = pct < 0.33 ? "High" : pct < 0.66 ? "Medium" : "Low";
    });
  }
  const summaries = domains.map((d) => {
    const total = domainTotals[d.id];
    const gaps = domainGaps[d.id];
    const favorable = total - gaps;
    const scorePct = pyRound((favorable / Math.max(total, 1)) * 100, 1);
    let estimated = "Seeding";
    for (let s = 1; s < 6; s++) {
      const qs = d.questions.filter((q) => q.stage === s);
      const allFav = qs.every((q) => !isGap(ans(answers, q.id), q.trigger_on));
      if (allFav && qs.length) estimated = stageNames[String(s)] ?? "Unknown";
      else break;
    }
    const recs = all.filter((r) => r.domain_id === d.id).sort((a, b) => b.score - a.score);
    return { domain_id: d.id, domain_name: d.name, total_questions: total, favorable_count: favorable,
      gap_count: gaps, score_pct: scorePct, estimated_stage: estimated, recommendations: recs };
  });
  return { gaps: all, summaries };
}

export const STEPS: [string, string][] = [
  ["read", "Reading your answers"], ["score", "Scoring capacity domains"],
  ["research", "Researching your organization's website"],
  ["library", "Consulting the CVI resource library"],
  ["write", "Writing personalized recommendations"],
  ["plain", "Checking it reads clearly"],
];

/** app.build_assessment: the deterministic part of an assessment (id and created are passed in). */
export function buildAssessment(bank: Bank, org: Json, answers: Json, domains: BankDomain[], profile: string | null,
  id: string, created: string, steps: [string, string][] = STEPS) {
  const { gaps, summaries } = calculateRecommendations(answers, domains, bank.stage_weights, bank.stage_names);
  const total = summaries.reduce((a, s) => a + s.total_questions, 0);
  const favorable = summaries.reduce((a, s) => a + s.favorable_count, 0);
  const count = (p: string) => gaps.filter((g) => g.priority === p).length;
  return {
    id, created,
    org_name: org.org_name, org_url: org.org_url, language: org.language,
    domain_ids: domains.map((d) => d.id), answers,
    overall: { total_questions: total, favorable, favorable_pct: pyRound((favorable / total) * 100, 1),
      total_gaps: gaps.length, high: count("High"), medium: count("Medium"), low: count("Low") },
    domains: summaries.map((s) => ({ domain_id: s.domain_id, domain_name: s.domain_name,
      total_questions: s.total_questions, favorable_count: s.favorable_count, gap_count: s.gap_count,
      score_pct: s.score_pct, estimated_stage: s.estimated_stage,
      high_count: s.recommendations.filter((g: Json) => g.priority === "High").length })),
    gaps,
    steps: steps.map(([key, label]) => ({ key, label, state: key === "read" || key === "score" ? "done" : "pending" })),
    status: "running", error: null, profile, progress: null, pdf_kb: null, report: null,
    support: null, org_meta: org.org_meta ?? null,
    respondent: org.respondent ?? null, org_links: org.org_links ?? null, answered_by: org.answered_by ?? null,
    research: null,
  } as Json;
}

/** app.compare: progress since the previous assessment, over the areas both covered. */
export function compare(prev: Json, sub: Json) {
  const shared = sub.domain_ids.filter((d: string) => prev.domain_ids.includes(d));
  if (!shared.length) return null;
  const before = prev.gaps.filter((g: Json) => shared.includes(g.domain_id));
  const now = sub.gaps.filter((g: Json) => shared.includes(g.domain_id));
  const beforeIds = new Set(before.map((g: Json) => g.question_id));
  const nowIds = new Set(now.map((g: Json) => g.question_id));
  const stages: Json = Object.fromEntries(prev.domains.map((d: Json) => [d.domain_id, d.estimated_stage]));
  return {
    previous_id: prev.id, previous_created: prev.created,
    closed: before.filter((g: Json) => !nowIds.has(g.question_id)).map((g: Json) => ({ id: g.question_id, text: g.question_text })),
    new: now.filter((g: Json) => !beforeIds.has(g.question_id)).map((g: Json) => ({ id: g.question_id, text: g.question_text })),
    stages: sub.domains.filter((d: Json) => shared.includes(d.domain_id)).map((d: Json) => ({
      domain_id: d.domain_id, domain_name: d.domain_name, from: stages[d.domain_id], to: d.estimated_stage })),
  };
}

/** pipeline.choose_focus: engine rank 1, then the best-ranked gap from another area (else rank 2). */
export function chooseFocus(gaps: Json[]) {
  if (!gaps.length) return [];
  const other = gaps.slice(1).filter((g) => g.domain_id !== gaps[0].domain_id);
  return [gaps[0], ...(other.length ? other : gaps.slice(1)).slice(0, 1)];
}

// ---------- features/milestones.py ----------

const WEEKS = 12;
const MAX_TASKS = 5;
const DAY = 24 * 3600 * 1000;
const UNLOCK_AFTER = 7 * DAY;
const TASK_POINTS = 10, WEEK_POINTS = 25;
export const DEFAULT_OWNER = "Leadership team";
export const ENGINE_WHY = "Your answers show this is one of your growth priorities.";
const CHECK_IN = "Meet with your team for 20 minutes: what did you finish, and what comes next?";
const CHECK_IN_WHY = "A short check-in keeps what is working going and shows what to do next.";
const RETAKE = "Retake the OCI to see your progress";
const LEVELS: [number, string][] = [[0, "Getting started"], [25, "Building"], [50, "Growing"], [75, "Leading"]];
const BADGES: [string, string, string][] = [
  ["first-step", "First step", "Finish your first step."],
  ["week-one", "Week one done", "Finish every step in week 1."],
  ["foundation", "Foundation builder", "Finish every step for your Start here priorities."],
  ["on-a-roll", "On a roll", "Get steps done 3 weeks in a row."],
  ["halfway", "Halfway there", "Finish 6 of the 12 weeks."],
  ["complete", "Roadmap complete", "Finish every action step in all 12 weeks."],
  ["retake", "Ready to retake", "Retake the OCI to see your progress."],
];

function steps(value: unknown): string[] {
  const list = typeof value === "string" ? value.split("\n") : Array.isArray(value) ? value : [];
  return list.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim());
}

function item(g: Json): Json {
  return { title: "Work on: " + g.question_text, why: ENGINE_WHY, gap_ids: [g.question_id],
    steps: steps(g.next_steps), resource: null, owner: DEFAULT_OWNER, lang: "en" };
}

export function engineReport(sub: Json) {
  const gaps: Json[] = sub.gaps || [];
  const focus = chooseFocus(gaps);
  const chosen = new Set(focus.map((g) => g.question_id));
  const rest = gaps.filter((g) => !chosen.has(g.question_id)).slice(0, 8);
  const horizons = [30, 30, 60, 60, 60, 90, 90, 90];
  return { focus: focus.map(item), plan: rest.map((g, i) => ({ ...item(g), horizon: horizons[i] })) };
}

export function resourceFor(items: Json[], catalog: CatalogEntry[]): Json | null {
  for (const it of items) if (it.resource) return it.resource;
  for (const it of items) {
    for (const d of (it.gap_ids || []).map((i: string) => i.replace(/\d+$/, ""))) {
      const r = catalog.find((r) => (r.domains || []).includes(d));
      if (r) return { title: r.title, url: r.url };
    }
  }
  return null;
}

function spread(n: number, items: Json[], spare: Json[], gaps: Record<string, Json>) {
  if (!items.length && spare.length) items.push(spare.shift()!);
  const pool: [Json, string, string][] = [];
  const seen = new Set<string>();
  const add = (it: Json, text: string, lang: string) => {
    // Python's str.lower(); toLowerCase matches it for these texts.
    if (!seen.has(text.toLowerCase())) { seen.add(text.toLowerCase()); pool.push([it, text, lang]); }
  };
  for (const it of items) for (const s of steps(it.steps)) add(it, s, it.lang);
  for (const it of items) {
    for (const gid of it.gap_ids || []) {
      for (const s of steps((gaps[gid] || {}).next_steps)) if (pool.length < 2 * n) add(it, s, "en");
    }
  }
  while (pool.length < n && spare.length) {
    const it = spare.shift()!;
    for (const s of it.steps) add(it, s, "en");
  }
  const size = Math.floor(pool.length / n), extra = pool.length % n;
  const chunks: [Json, string, string][][] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const end = start + size + (i < extra ? 1 : 0);
    chunks.push(pool.slice(start, end).slice(0, MAX_TASKS));
    start = end;
  }
  return chunks;
}

export function buildRoadmap(sub: Json, catalog: CatalogEntry[]) {
  const report = sub.report;
  const ai = !!(report && report.plan && report.plan.length);
  const lang = sub.language || "en";
  let focus: Json[], plan: Json[];
  if (ai) {
    focus = (report.focus || []).map((f: Json) => ({ ...f, owner: DEFAULT_OWNER, lang }));
    plan = report.plan.map((p: Json) => ({ ...p, lang }));
  } else {
    const fb = engineReport(sub);
    focus = fb.focus; plan = fb.plan;
  }
  const gaps: Record<string, Json> = Object.fromEntries((sub.gaps || []).map((g: Json) => [g.question_id, g]));
  const cited = new Set([...focus, ...plan].flatMap((it) => it.gap_ids || []));
  const spare = (sub.gaps || []).filter((g: Json) => !cited.has(g.question_id)).map(item);
  const groups: [number[], Json[], boolean][] = [[[1, 2], focus.slice(0, 1), true]];
  if (focus.length > 1) groups.push([[3, 4], focus.slice(1, 2), true]);
  const by = (h: number) => plan.filter((p) => p.horizon === h);
  groups.push([focus.length > 1 ? [5, 6] : [3, 4, 5, 6], by(30), false], [[7, 8, 9], by(60), false], [[10, 11, 12], by(90), false]);
  const weeks: Json[] = [];
  let lead: Json | null = null;
  for (const [nums, items, isFocus] of groups) {
    const chunks = spread(nums.length, [...items], spare, gaps);
    nums.forEach((n, idx) => {
      let chunk = chunks[idx];
      if (n === WEEKS) chunk = chunk.slice(0, MAX_TASKS - 1);
      lead = chunk.length ? chunk[0][0] : lead;
      let tasks: Json[] = chunk.map(([it, text, tl], j) => ({ id: `w${n}-${j + 1}`, text, gap_ids: [...(it.gap_ids || [])],
        owner: it.owner || DEFAULT_OWNER, lang: tl }));
      if (!tasks.length) tasks = [{ id: `w${n}-1`, text: CHECK_IN, gap_ids: [], owner: DEFAULT_OWNER, lang: "en" }];
      if (n === WEEKS) tasks.push({ id: `w${n}-${tasks.length + 1}`, text: RETAKE, gap_ids: [], owner: DEFAULT_OWNER, lang: "en", retake: true });
      const L = lead as Json | null;
      weeks.push({ n, focus: isFocus, title: L ? L.title : "Check in with your team",
        why: (L || {}).why || (L ? ENGINE_WHY : CHECK_IN_WHY), lang: L ? L.lang : "en",
        resource: resourceFor(chunk.length ? chunk.map((c) => c[0]) : L ? [L] : [], catalog), tasks });
    });
  }
  for (let i = 1; i < weeks.length; i++) {
    const prevTitle = weeks[i - 1].title.endsWith(" (continued)") ? weeks[i - 1].title.slice(0, -12) : weeks[i - 1].title;
    if (weeks[i].title === prevTitle) weeks[i].title += " (continued)";
  }
  return { ai, weeks };
}

/** milestones.progress: unlocks, counts, points, streaks, badges and level. Times are epoch ms. */
export function progress(roadmap: Json, done: Record<string, number>, created: number, now: number) {
  const weeks: Json[] = [];
  let unlock = created;
  for (const w of roadmap.weeks) {
    const times = w.tasks.filter((t: Json) => t.id in done).map((t: Json) => done[t.id]);
    if (times.length) unlock = Math.min(unlock, Math.min(...times));
    const complete = times.length === w.tasks.length ? Math.max(...times) : null;
    const state = complete !== null ? "done" : unlock <= now ? "open" : "locked";
    weeks.push({ ...w, state, unlocks_at: unlock, done_count: times.length,
      tasks: w.tasks.map((t: Json) => ({ ...t, done: t.id in done })) });
    unlock = complete !== null ? Math.min(unlock + UNLOCK_AFTER, Math.max(complete, unlock)) : unlock + UNLOCK_AFTER;
  }
  const total = weeks.reduce((a, w) => a + w.tasks.length, 0);
  const nDone = weeks.reduce((a, w) => a + w.done_count, 0);
  const weeksDone = weeks.filter((w) => w.state === "done").length;
  const active = weeks.map((w) => w.done_count > 0);
  let best = 0, run = 0;
  for (const a of active) { run = a ? run + 1 : 0; best = Math.max(best, run); }
  const openIdx = weeks.map((w, i) => (w.state !== "locked" ? i : -1)).filter((i) => i >= 0);
  let k = openIdx.length ? Math.max(...openIdx) : 0;
  if (!active[k] && k > 0) k -= 1;
  let streak = 0;
  while (k >= 0 && active[k]) { streak += 1; k -= 1; }
  const pct = total ? pyRound((100 * nDone) / total) : 0;
  const level = LEVELS.filter(([floor]) => pct >= floor).at(-1)![1];
  const nxt = LEVELS.find(([floor]) => pct < floor) || null;
  const tasks = weeks.flatMap((w) => w.tasks);
  const focusWeeks = weeks.filter((w) => w.focus);
  const earned: Record<string, boolean> = {
    "first-step": nDone >= 1,
    "week-one": weeks[0].state === "done",
    foundation: focusWeeks.length > 0 && focusWeeks.every((w) => w.state === "done"),
    "on-a-roll": best >= 3,
    halfway: weeksDone >= 6,
    complete: tasks.filter((t) => !t.retake).every((t) => t.done),
    retake: tasks.some((t) => t.retake && t.done),
  };
  const locked = weeks.find((w) => w.state === "locked");
  return {
    ai: roadmap.ai, weeks, total_tasks: total, done_tasks: nDone, weeks_done: weeksDone, pct,
    points: TASK_POINTS * nDone + WEEK_POINTS * weeksDone, level,
    next_level: nxt ? { name: nxt[1], steps: Math.max(1, Math.ceil((nxt[0] * total) / 100) - nDone) } : null,
    streak, best_streak: best,
    badges: BADGES.map(([id, name, description]) => ({ id, name, description, earned: earned[id] })),
    current_week: weeks.find((w) => w.state === "open")?.n ?? null,
    next_unlock: locked ? { week: locked.n, date: ymd(locked.unlocks_at) } : null,
  } as Json;
}

export const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** milestones._view for the organization (locked weeks show only their title and opening date). */
export function roadmapView(sub: Json, state: Json) {
  const weeks = state.weeks.map((w: Json) => {
    const out: Json = { n: w.n, title: w.title, lang: w.lang, focus: w.focus, state: w.state,
      unlocks_on: ymd(w.unlocks_at), done_count: w.done_count, task_count: w.tasks.length };
    if (w.state !== "locked") Object.assign(out, { why: w.why, resource: w.resource, tasks: w.tasks });
    return out;
  });
  const shown = new Set(weeks.flatMap((w: Json) => (w.tasks || []).flatMap((t: Json) => t.gap_ids)));
  const rest = Object.fromEntries(Object.entries(state).filter(([k]) => k !== "weeks"));
  return { ...rest, weeks, assessment_id: sub.id, org_name: sub.org_name, language: sub.language || "en", staff: false,
    statements: Object.fromEntries((sub.gaps || []).filter((g: Json) => shown.has(g.question_id))
      .map((g: Json) => [g.question_id, g.question_text])) };
}

/** "YYYY-MM-DD HH:MM UTC" (app.build_assessment) to epoch ms, as milestones._created reads it. */
export function createdMs(created: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) UTC$/.exec(created || "");
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : Date.now();
}

export const createdStamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
