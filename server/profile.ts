import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"

/**
 * Wearer profile: the foods to avoid. The caregiver edits it on the caregiver page as free text (saved to
 * data/profile.json, default peanuts, milk and shellfish). It lives on the server only, never on the glasses.
 * Common words are mapped to a known allergen with its synonyms ("dairy" is milk); anything else is matched as the word itself.
 */
const FILE = "./data/profile.json"
const DEFAULT_AVOID = ["peanuts", "milk", "shellfish"]

function load(): string[] {
  try {
    if (existsSync(FILE)) {
      const j = JSON.parse(readFileSync(FILE, "utf-8")) as {avoid?: unknown}
      if (Array.isArray(j.avoid)) return clean(j.avoid)
    }
  } catch (e) {
    console.warn("[profile] could not read", FILE, (e as Error).message)
  }
  return [...DEFAULT_AVOID]
}

/** `avoid` is read at call time by Food Check, so an edit applies to the next check without a restart. */
export const PROFILE = {avoid: [] as string[]}

/** What people type that means a known allergen. */
const ALIASES: Record<string, string> = {
  dairy: "milk", lactose: "milk", "cow's milk": "milk", cheese: "milk", peanut: "peanuts", "peanut allergy": "peanuts",
  nuts: "tree nuts", nut: "tree nuts", "tree nut": "tree nuts", egg: "eggs", shrimp: "shellfish", prawns: "shellfish",
  crab: "shellfish", lobster: "shellfish", seafood: "shellfish", soya: "soy", soybean: "soy", soybeans: "soy",
  gluten: "wheat", wheat: "wheat", sesame: "sesame", "sesame seeds": "sesame",
}

/** Clean free text into a list: trimmed, lower case, known words mapped, no blanks or duplicates, sane length. */
export function clean(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const raw of list) {
    if (typeof raw !== "string") continue
    const t = raw.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 40)
    if (t.length < 2) continue
    const item = ALIASES[t] ?? t
    if (!out.includes(item)) out.push(item)
    if (out.length >= 30) break
  }
  return out
}

/** Replace the avoid list. Returns the saved (cleaned) list. */
export function setAvoid(list: unknown): string[] {
  const cleaned = clean(list)
  PROFILE.avoid = cleaned
  try {
    mkdirSync("./data", {recursive: true})
    writeFileSync(FILE, JSON.stringify({avoid: cleaned}, null, 2))
  } catch (e) {
    console.warn("[profile] could not save:", (e as Error).message)
  }
  return cleaned
}

/** Suggestions shown as quick-add buttons. The list is free text; these are only shortcuts. */
export const ALLERGEN_OPTIONS = () => Object.keys(ALLERGENS)

/** Extra word sets for common things people type that are not one of the nine allergens. */
const EXTRA: Record<string, {terms: string[]; exclude?: string[]}> = {
  pork: {terms: ["pork", "bacon", "ham", "lard", "prosciutto", "pepperoni", "salami", "sausage"]},
  beef: {terms: ["beef", "steak", "veal"]},
  alcohol: {terms: ["alcohol", "wine", "beer", "liquor", "vodka", "rum", "whiskey", "whisky", "gin", "brandy"]},
  caffeine: {terms: ["caffeine", "coffee", "espresso", "energy drink", "guarana"]},
}
/** Words that mean an allergen is present. `exclude` removes false friends first ("peanut butter" is not dairy). */
export const ALLERGENS: Record<string, {terms: string[]; exclude?: string[]}> = {
  peanuts: {terms: ["peanut", "groundnut", "arachis"]},
  "tree nuts": {
    terms: ["tree nut", "almond", "cashew", "walnut", "pecan", "pistachio", "hazelnut", "macadamia", "brazil nut"],
  },
  milk: {
    terms: ["milk", "whey", "casein", "caseinate", "lactose", "butter", "buttermilk", "cream", "cheese", "yogurt", "yoghurt", "ghee", "dairy", "ice cream", "gelato", "custard", "mozzarella", "cheddar", "parmesan", "ricotta", "kefir", "whipped cream", "sour cream"],
    exclude: ["peanut butter", "almond butter", "nut butter", "cocoa butter", "shea butter", "coconut milk", "almond milk", "soy milk", "oat milk", "rice milk", "coconut cream", "cream of tartar"],
  },
  eggs: {terms: ["egg", "albumin", "mayonnaise", "omelet", "omelette", "meringue"]},
  soy: {terms: ["soy", "soya", "soybean", "edamame", "tofu"]},
  wheat: {terms: ["wheat", "gluten", "semolina", "spelt"]},
  fish: {terms: ["fish", "salmon", "tuna", "cod", "anchovy", "anchovies"]},
  shellfish: {terms: ["shellfish", "shrimp", "prawn", "crab", "lobster", "crayfish", "clam", "oyster", "mussel", "scallop", "mollusc", "mollusk"]},
  sesame: {terms: ["sesame", "tahini"]},
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** True if `text` (label wording) mentions the allergen. */
export function mentions(text: string | null | undefined, allergen: string): boolean {
  if (!text) return false
  // A known allergen uses its synonyms; otherwise match the typed word itself (singular or plural, whole words).
  const base = allergen.replace(/s$/, "")
  const def = ALLERGENS[allergen] ?? EXTRA[allergen] ?? {terms: [allergen, base]}
  let t = text.toLowerCase()
  for (const x of def.exclude ?? []) t = t.split(x).join(" ")
  return def.terms.some((term) => new RegExp(`\\b${escape(term)}s?\\b`).test(t))
}

PROFILE.avoid = load()
