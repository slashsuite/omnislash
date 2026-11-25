// OS-240: the options of the Models page's model dropdowns. They are Jacobus's T3 favourites as `ob models
// sync-favorites` last stored them (`<provider>:<model>`). A stored model that is not one of them is still offered,
// marked, so a chain that names it shows what it runs and saves it back unchanged.

export const NOT_A_FAVOURITE = "not a favourite";

export type ModelItem = { value: string; label: string; disabled?: boolean };

/** The dropdown's choices for a picker holding `value`: the favourites, plus `value` marked when it is not one. */
export function modelItems(favourites: readonly string[], value: string): ModelItem[] {
  const items: ModelItem[] = favourites.map((m) => ({ value: m, label: m }));
  if (value === "") return [{ value: "", label: "pick a model", disabled: true }, ...items];
  if (!favourites.includes(value)) return [{ value, label: `${value} (${NOT_A_FAVOURITE})` }, ...items];
  return items;
}

/** A chain's text (`a, b`) as its entries. */
export function chainOf(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

/** The model a new chain row starts on: the first favourite the chain does not hold yet, else the first, else none. */
export function nextModel(favourites: readonly string[], chain: readonly string[]): string {
  return favourites.find((m) => !chain.includes(m)) ?? favourites[0] ?? "";
}

/** `chain` with entry `i` moved by `by` (-1 up, +1 down); unchanged at either end. */
export function move<T>(chain: readonly T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (j < 0 || j >= chain.length) return [...chain];
  const next = [...chain];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}
