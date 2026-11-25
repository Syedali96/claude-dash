// Exercise names: one canonical name per lift, so "seated pull down", "pull down"
// and "lat pulldown" all count as the same exercise for history and "last time".
// Shared by the glasses app and the Worker.

/** Canonical name -> other ways it gets said. */
const ALIASES: Record<string, string[]> = {
  "Lat Pulldown": ["pulldown", "lat pulldown", "seated pulldown", "seated lat pulldown", "wide grip pulldown", "cable pulldown", "machine pulldown", "lat pull"],
  "Bench Press": ["bench", "flat bench", "barbell bench", "barbell bench press", "flat bench press", "bench presses"],
  "Incline Bench Press": ["incline bench", "incline press", "incline barbell press", "incline barbell bench"],
  "Incline Dumbbell Press": ["incline db press", "incline dumbbell bench", "incline dumbbell bench press"],
  "Dumbbell Bench Press": ["db bench", "dumbbell bench", "db bench press", "dumbbell press"],
  "Squat": ["back squat", "barbell squat", "squats", "back squats"],
  "Front Squat": ["front squats"],
  "Deadlift": ["dead lift", "deadlifts", "conventional deadlift", "barbell deadlift"],
  "Romanian Deadlift": ["rdl", "rdls", "romanian dead lift", "stiff leg deadlift"],
  "Overhead Press": ["ohp", "military press", "shoulder press", "standing press", "barbell overhead press", "seated shoulder press", "dumbbell shoulder press", "db shoulder press"],
  "Barbell Row": ["bent over row", "bentover row", "barbell bent over row", "bb row"],
  "Seated Cable Row": ["cable row", "seated row", "low row", "cable rows", "seated rows"],
  "Dumbbell Row": ["db row", "one arm row", "single arm row", "one arm dumbbell row"],
  "Pull-Up": ["pullup", "pull up", "pullups", "pull ups"],
  "Chin-Up": ["chinup", "chin up", "chinups", "chin ups"],
  "Dip": ["dips", "chest dip", "tricep dip", "triceps dip"],
  "Leg Press": ["leg presses", "machine leg press"],
  "Leg Extension": ["leg extensions", "quad extension"],
  "Leg Curl": ["leg curls", "hamstring curl", "lying leg curl", "seated leg curl"],
  "Lateral Raise": ["lat raise", "side raise", "side lateral raise", "lateral raises", "side raises", "dumbbell lateral raise", "cable lateral raise"],
  "Bicep Curl": ["curl", "curls", "biceps curl", "dumbbell curl", "db curl", "barbell curl", "bicep curls"],
  "Hammer Curl": ["hammer curls"],
  "Tricep Pushdown": ["pushdown", "triceps pushdown", "rope pushdown", "tricep rope pushdown", "cable pushdown", "pushdowns"],
  "Skull Crusher": ["skull crushers", "skullcrusher", "lying tricep extension"],
  "Cable Fly": ["cable flye", "cable flies", "cable flyes", "cable crossover", "chest fly", "pec fly", "pec deck", "machine fly"],
  "Face Pull": ["face pulls"],
  "Hip Thrust": ["hip thrusts", "barbell hip thrust", "glute bridge"],
  "Calf Raise": ["calf raises", "standing calf raise", "seated calf raise"],
  "Lunge": ["lunges", "walking lunge", "walking lunges"],
  "Bulgarian Split Squat": ["split squat", "bulgarian split squats", "split squats", "bss"],
  "Shrug": ["shrugs", "dumbbell shrug", "barbell shrug"],
};

/** Lowercase, no punctuation, singular-ish, collapsed spaces. */
export function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_]/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\bpull downs?\b/g, "pulldown")
    .replace(/\bpush downs?\b/g, "pushdown")
    .replace(/\bdumbbells?\b/g, "dumbbell")
    .replace(/\s+/g, " ")
    .trim();
}

const LOOKUP = new Map<string, string>();
for (const [canon, alts] of Object.entries(ALIASES)) {
  LOOKUP.set(normalize(canon), canon);
  for (const a of alts) LOOKUP.set(normalize(a), canon);
}

/** The canonical name if we know this lift, else null. */
export function knownName(name: string): string | null {
  const n = normalize(name);
  return LOOKUP.get(n) ?? LOOKUP.get(n.replace(/s$/, "")) ?? null;
}

/** A key that's the same for every way of saying one lift. */
export function exerciseKey(name: string): string {
  const k = knownName(name);
  return k ? normalize(k) : normalize(name).replace(/s$/, "");
}

/** Pick the name to save: an alias match, else one you've used before, else as heard. */
export function canonicalName(name: string, used: string[] = []): string {
  const known = knownName(name);
  if (known) return known;
  const key = exerciseKey(name);
  return used.find((u) => exerciseKey(u) === key) ?? name;
}

// ---------- rest by exercise type ----------

export type LiftType = "heavy" | "compound" | "isolation";

const HEAVY = new Set(["Squat", "Front Squat", "Bench Press", "Deadlift", "Romanian Deadlift", "Overhead Press", "Barbell Row", "Incline Bench Press"]);
const ISOLATION_WORDS = /\b(curl|raise|extension|fly|flye|pushdown|kickback|calf|shrug|crunch|face pull|pec deck|crossover|skull|wrist|abductor|adductor|plank)\b/;

export function liftType(name: string): LiftType {
  const known = knownName(name);
  if (known && HEAVY.has(known)) return "heavy";
  if (ISOLATION_WORDS.test(normalize(known ?? name))) return "isolation";
  return "compound";
}
