export type Project = { id: string; name: string };
export const createProject = (name: string) => fetch("/api/projects", { method: "POST", body: JSON.stringify({ name }) });
export const listProjects = async (): Promise<Project[]> => (await fetch("/api/projects")).json();
