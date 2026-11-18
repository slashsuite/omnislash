export function DocsRail({ links }: { links: { href: string; title: string }[] }) {
  return (
    <nav aria-label="Docs" className="sticky top-16 h-fit">
      <ul>
        {links.map((l) => (
          <li key={l.href}><a href={l.href}>{l.title}</a></li>
        ))}
      </ul>
    </nav>
  );
}
