import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"

/**
 * Wearer profile: the foods to avoid. The caregiver edits it on the caregiver page (saved to data/profile.json,
 * default peanuts, milk and shellfish). It lives on the server only, never on the glasses.
 */
const FILE = "./data/profile.json"
const DEFAULT_AVOID = ["peanuts", "milk", "shellfish"]

function load(): string[] {
  try {
    if (existsSync(FILE)) {
      const j = JSON.parse(readFileSync(FILE, "utf-8")) as {avoid?: unknown}
      if (Array.isArray(j.avoid)) return j.avoid.filter((a): a is string => typeof a === "string" && a in ALLERGENS)
    }
  } catch (e) {
    console.warn("[profile] could not read", FILE, (e as Error).message)
  }
  return [...DEFAULT_AVOID]
}

/** `avoid` is read at call time by Food Check, so an edit applies to the next check without a restart. */
export const PROFILE = {avoid: [] as string[]}

/** Replace the avoid list. Unknown names are ignored. Returns the saved list. */
export function setAvoid(list: unknown): string[] {
  const clean = Array.isArray(list) ? [...new Set(list.filter((a): a is string => typeof a === "string" && a in ALLERGENS))] : []
  PROFILE.avoid = clean
  try {
    mkdirSync("./data", {recursive: true})
    writeFileSync(FILE, JSON.stringify({avoid: clean}, null, 2))
  } catch (e) {
    console.warn("[profile] could not save:", (e as Error).message)
  }
  return clean
}

export const ALLERGEN_OPTIONS = () => Object.keys(ALLERGENS)
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
  const def = ALLERGENS[allergen]
  if (!def || !text) return false
  let t = text.toLowerCase()
  for (const x of def.exclude ?? []) t = t.split(x).join(" ")
  return def.terms.some((term) => new RegExp(`\\b${escape(term)}s?\\b`).test(t))
}

PROFILE.avoid = load()
