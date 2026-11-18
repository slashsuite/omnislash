import type { Project } from "../api";

export function ArchivePage({ projects }: { projects: Project[] }) {
  return (
    <main>
      <h1>Archive</h1>
      {projects.length === 0 ? (
        <p>No archived projects yet.</p>
      ) : (
        <ul>
          {projects.map((p) => (
            <li key={p.id}>{p.name}</li>
          ))}
        </ul>
      )}
    </main>
  );
}
