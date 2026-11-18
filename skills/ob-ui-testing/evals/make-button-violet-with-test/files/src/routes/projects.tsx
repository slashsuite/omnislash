import { useState } from "react";
import { createProject, listProjects, type Project } from "../api";
import { validateProjectName } from "../projectName";

export function ProjectsPage({ initial, canCreate }: { initial: Project[]; canCreate: boolean }) {
  const [projects, setProjects] = useState(initial);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const problem = validateProjectName(name, projects.map((p) => p.name));
    if (problem) return setError(problem);
    setPending(true);
    const res = await createProject(name); // POST /api/projects
    setPending(false);
    if (!res.ok) return setError(res.status === 409 ? "A project with that name exists" : "Could not save, try again");
    setProjects(await listProjects());
    setName("");
  }

  return (
    <main>
      <h1>Projects</h1>
      {projects.length === 0 ? <p>No projects yet</p> : (
        <ul aria-label="Projects">{projects.map((p) => <li key={p.id}><a href={`/projects/${p.id}`}>{p.name}</a></li>)}</ul>
      )}
      {canCreate && (
        <form onSubmit={onSubmit} className="card mt-4">
          <label>Project name <input value={name} onChange={(e) => setName(e.target.value)} /></label>
          {error && <p role="alert" className="text-red-600">{error}</p>}
          <button type="submit" disabled={pending} className="bg-violet-600">Create</button>
        </form>
      )}
    </main>
  );
}
