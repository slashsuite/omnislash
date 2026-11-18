import { useEffect, useState } from "react";
type Repo = { id: number; full_name: string };
export function ImportPage() {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => { fetch("/api/github/repos").then((r) => r.json()).then(setRepos); }, []); // server calls api.github.com with the user's token
  if (!repos) return <p role="status">Loading repositories</p>;
  return (
    <main><h1>Import from GitHub</h1>
      <ul aria-label="Repositories">{repos.map((r) => (
        <li key={r.id}>{r.full_name} <button type="button" onClick={async () => {
          const res = await fetch("/api/projects/import", { method: "POST", body: JSON.stringify({ repoId: r.id }) });
          if (res.ok) setDone(r.full_name);
        }}>Import {r.full_name}</button></li>))}</ul>
      {done && <p role="status">Imported {done}</p>}
    </main>
  );
}
