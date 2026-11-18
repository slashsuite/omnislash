import { Outlet } from "@tanstack/react-router";
import { ThemeToggle } from "./components/ThemeToggle";
export function Root() {
  return (<><header><a href="/">Acme</a><nav aria-label="Main"><a href="/projects">Projects</a><a href="/pricing">Pricing</a></nav><ThemeToggle /></header><Outlet /></>);
}
