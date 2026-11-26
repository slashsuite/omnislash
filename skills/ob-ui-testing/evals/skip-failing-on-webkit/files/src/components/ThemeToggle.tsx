import { useEffect, useState } from "react";
export function ThemeToggle() {
  const [dark, setDark] = useState(() => localStorage.getItem("theme") === "dark");
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); localStorage.setItem("theme", dark ? "dark" : "light"); }, [dark]);
  return <button onClick={() => setDark(!dark)}>{dark ? "Light mode" : "Dark mode"}</button>;
}
