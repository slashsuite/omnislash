// The eval fixtures assert jest-dom matchers (toHaveClass, toBeDisabled) that a project under test registers in its own
// setup; this puts their types on `expect` for the skills typecheck without editing a fixture the eval reads.
import "@testing-library/jest-dom/vitest";
