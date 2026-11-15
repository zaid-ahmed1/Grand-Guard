import {readFileSync, writeFileSync} from "node:fs"
function patch(p: string, edits: [string, string][]) {
  let s = readFileSync(p, "utf-8"); const crlf = s.includes("\r\n"); s = s.replace(/\r\n/g, "\n")
  for (const [a, b] of edits) { if (!s.includes(a)) throw new Error(p + " missing " + a.slice(0, 50)); s = s.replace(a, () => b) }
  if (crlf) s = s.replace(/\n/g, "\r\n"); writeFileSync(p, s)
}
patch("src/background/engine.ts", [
[`can i eat (this|that)|(is|are) (this|that|these) (food )?(safe|ok|okay|good) to eat|`, `can i (eat|drink) (this|that)|(is|are) (this|that|these) (food |drink )?(safe|ok|okay|good) to (eat|drink)|check (this|that) (drink|beverage|bottle|juice|carton|cup)|`],
[`const FOODISH = /\b(food|expired|allerg\w*|safe to eat|can i eat)\b/`, `const FOODISH = /\b(food|drink|beverage|expired|allerg\w*|safe to (eat|drink)|can i (eat|drink))\b/`],
])
patch("server/router.ts", [
[`is safe to eat, contains an allergen, or is expired.`, `is safe to eat or drink, contains an allergen, or is expired. Includes "can I drink this".`],
])
patch("server/food.ts", [
[`  frontText?: string | null\n`, `  frontText?: string | null\n  /** True for a beverage (juice, milk, soda, a bottle or carton to drink). */\n  isDrink?: boolean\n`],
[`{"isFood":true|false,"productName"`, `{"isFood":true|false,"isDrink":true|false,"productName"`],
[`isFood is false if the photo does not show a food or drink item.`, `isFood is false if the photo does not show a food or drink item. isDrink is true when the item is a beverage meant to be drunk (juice, milk, soda, water, a drink bottle or carton), false otherwise.`],
[`  const advice = severity === "danger" ? "Do not eat this." : severity === "warn" ? "Please check the label before eating."`, `  // Say "drink" for beverages, whether the model flagged one or the name makes it plain.
  const drink = label.isDrink === true || /\b(juice|soda|cola|lemonade|smoothie|beverage|drink|water|milk|tea|coffee|beer|wine)\b/i.test(named)
  const advice = severity === "danger" ? \`Do not \${drink ? "drink" : "eat"} this.\` : severity === "warn" ? \`Please check the label before \${drink ? "drinking" : "eating"}.\``],
[`Responded: \${severity === "danger" ? "do not eat this"`, `Responded: \${severity === "danger" ? \`do not \${drink ? "drink" : "eat"} this\``],
])
