/**
 * Wearer profile. Hard-coded for now; the caregiver companion app will make this editable
 * (spec §6.5). It lives on the server only, never on the glasses.
 */
export const PROFILE = {
  /** Allergens the wearer avoids. Keys must exist in ALLERGENS below. */
  avoid: ["peanuts", "milk", "shellfish"],
}

/** Words that mean an allergen is present. `exclude` removes false friends first ("peanut butter" is not dairy). */
export const ALLERGENS: Record<string, {terms: string[]; exclude?: string[]}> = {
  peanuts: {terms: ["peanut", "groundnut", "arachis"]},
  "tree nuts": {
    terms: ["tree nut", "almond", "cashew", "walnut", "pecan", "pistachio", "hazelnut", "macadamia", "brazil nut"],
  },
  milk: {
    terms: ["milk", "whey", "casein", "caseinate", "lactose", "butter", "buttermilk", "cream", "cheese", "yogurt", "yoghurt", "ghee", "dairy"],
    exclude: ["peanut butter", "almond butter", "nut butter", "cocoa butter", "shea butter", "coconut milk", "almond milk", "soy milk", "oat milk", "rice milk", "coconut cream", "cream of tartar"],
  },
  eggs: {terms: ["egg", "albumin", "mayonnaise"]},
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
