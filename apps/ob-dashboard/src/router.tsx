import { LinkProvider } from '@hackcove/ui-react'
import { createRouter as createTanStackRouter, Link } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    defaultViewTransition: true,
    // @hackcove/ui-react 0.11: every part that links takes a plain `href` and draws it through this adapter.
    // `to="."` satisfies the typed `to`; TanStack builds the location from the spread `href` (route-tests/router-link).
    InnerWrap: ({ children }) => (
      <LinkProvider link={(p) => <Link to="." {...p} />}>{children}</LinkProvider>
    ),
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
