/** 1 to 64 characters, letters, digits, spaces and hyphens; unique ignoring case. */
export function validateProjectName(name: string, existing: string[]): string | null {
  const n = name.trim();
  if (n.length === 0) return "Name is required";
  if (n.length > 64) return "Name is at most 64 characters";
  if (!/^[A-Za-z0-9 -]+$/.test(n)) return "Use letters, digits, spaces and hyphens";
  if (existing.some((e) => e.toLowerCase() === n.toLowerCase())) return "A project with that name exists";
  return null;
}
