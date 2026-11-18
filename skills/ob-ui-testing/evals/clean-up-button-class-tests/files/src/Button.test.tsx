import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
  it("renders primary tone", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button")).toHaveClass("bg-violet-600");
    expect(screen.getByRole("button")).not.toHaveClass("bg-red-600");
  });
  it("renders danger tone", () => {
    render(<Button tone="danger">Delete</Button>);
    expect(screen.getByRole("button").className).toContain("bg-red-600");
  });
  it("shows pressed", () => {
    render(<Button pressed>Bold</Button>);
    expect(screen.getByRole("button")).toHaveClass("ring-2");
  });
  it("disabled is faded", () => {
    render(<Button disabled>Save</Button>);
    expect(screen.getByRole("button")).toHaveClass("opacity-50");
  });
  it("clicks", () => {
    const onClick = vi.fn();
    const { container } = render(<Button onClick={onClick}>Save</Button>);
    fireEvent.click(container.querySelector("button")!);
    expect(onClick).toHaveBeenCalled();
  });
  it("matches markup", () => {
    const { container } = render(<Button>Save</Button>);
    expect(container.innerHTML).toBe('<button type="button" class="bg-violet-600 text-white rounded-md px-4 py-2  ">Save</button>');
  });
});
