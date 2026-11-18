// OB-2169: the short label a lease marker carries in a thread title (`🔒🌐`, `⏳🔌5101`, `🔒ob-2169-a`).
//
// `leaseIcon` is the ONE place an icon is looked up. OB-2170 replaces the built-in table below with the stored,
// dashboard-edited one; nothing else may read the table or hard-code an icon.

/** The built-in icons: an exact resource, or a whole class (the part before the first `:`). */
const BUILT_IN_ICONS: { readonly exact: Readonly<Record<string, string>>; readonly byClass: Readonly<Record<string, string>> } = {
  exact: { "cpu:browser": "🌐" },
  byClass: { port: "🔌" },
};

/** The class of a lease key (`port` for `port:5101`), or "" for a key without one. Pure. */
function leaseClass(resource: string): string {
  const i = resource.indexOf(":");
  return i < 0 ? "" : resource.slice(0, i);
}

/** The value after the class (`5101` for `port:5101`), the whole key when it has no class. Pure. */
function leaseValue(resource: string): string {
  const i = resource.indexOf(":");
  return i < 0 ? resource : resource.slice(i + 1);
}

/**
 * The icon for a lease key: `exact` when the whole resource has one (the label is the icon alone), `class` when
 * only its class has one (the label is the icon then the value), or null.
 */
export function leaseIcon(resource: string): { icon: string; match: "exact" | "class" } | null {
  const exact = BUILT_IN_ICONS.exact[resource];
  if (exact) return { icon: exact, match: "exact" };
  const byClass = BUILT_IN_ICONS.byClass[leaseClass(resource)];
  return byClass ? { icon: byClass, match: "class" } : null;
}

/**
 * The short label of a lease in a title marker, first rule that applies: the exact resource's icon (`🌐`); its
 * class icon and the value (`🔌5101`); otherwise the value after the class (`ob-2169-a`), a `worktree:` path giving
 * its last segment. Never empty, never carries whitespace (a marker run is split on spaces). Pure.
 */
export function leaseLabel(resource: string): string {
  const r = resource.trim();
  const icon = leaseIcon(r);
  let label: string;
  if (icon?.match === "exact") label = icon.icon;
  else {
    let value = leaseValue(r);
    if (leaseClass(r) === "worktree") value = value.replace(/\/+$/, "").split("/").pop() ?? value;
    label = `${icon ? icon.icon : ""}${value}`;
  }
  label = label.replace(/\s+/gu, "_");
  return label || r.replace(/\s+/gu, "_") || "?";
}
