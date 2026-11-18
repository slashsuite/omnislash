import type { Store } from "./test/store";
export type Project = { id: string; name: string; archivedAt: string | null };
export async function listArchived(store: Store): Promise<Project[]> {
  return store.all<Project>("select * from projects where archivedAt is not null order by archivedAt desc");
}
