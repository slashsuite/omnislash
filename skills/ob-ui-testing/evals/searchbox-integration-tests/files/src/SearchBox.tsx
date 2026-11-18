import { useEffect, useState } from "react";
type Hit = { id: string; title: string };
export function SearchBox({ search }: { search: (q: string) => Promise<Hit[]> }) {
  const [q, setQ] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "loading" } | { kind: "done"; hits: Hit[] } | { kind: "error" }>({ kind: "idle" });
  useEffect(() => {
    if (!q) return setState({ kind: "idle" });
    const t = setTimeout(async () => {
      setState({ kind: "loading" });
      try { setState({ kind: "done", hits: await search(q) }); } catch { setState({ kind: "error" }); }
    }, 300);
    return () => clearTimeout(t);
  }, [q, search]);
  return (
    <div role="search">
      <label>Search <input value={q} onChange={(e) => setQ(e.target.value)} /></label>
      {state.kind === "loading" && <p role="status">Searching</p>}
      {state.kind === "error" && <p role="alert">Search failed</p>}
      {state.kind === "done" && (state.hits.length === 0 ? <p>No results</p> :
        <ul aria-label="Results">{state.hits.map((h) => <li key={h.id}>{h.title}</li>)}</ul>)}
    </div>
  );
}
