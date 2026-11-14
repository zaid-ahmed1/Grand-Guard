/**
 * Extended thinking can use up the whole max_tokens budget and return no text, which made ambiguous
 * inputs fail JSON parsing and fall back to the keyword heuristic. Our calls want short JSON, so turn it off.
 * Haiku takes "disabled"; Sonnet takes "between_tools" (the API rejects "disabled" there).
 */
export const thinkingOff = (model: string) => (model.includes("haiku") ? {type: "disabled"} : {type: "between_tools"})
