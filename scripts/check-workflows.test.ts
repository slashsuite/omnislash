import { describe, expect, test } from "bun:test";
import { checkWorkflow } from "./check-workflows.ts";

describe("checkWorkflow", () => {
  test("ubuntu-latest passes", () => {
    const text = `jobs:\n  gate:\n    runs-on: ubuntu-latest\n    steps: []\n`;
    expect(checkWorkflow("ci.yml", text)).toEqual([]);
  });

  test("self-hosted fails", () => {
    const text = `jobs:\n  gate:\n    runs-on: self-hosted\n`;
    expect(checkWorkflow("ci.yml", text)).toHaveLength(1);
  });

  test("a label list containing self-hosted fails", () => {
    const text = `jobs:\n  gate:\n    runs-on: [self-hosted, linux]\n`;
    expect(checkWorkflow("ci.yml", text)).toHaveLength(1);
  });

  test("an expression fails", () => {
    const text = `jobs:\n  gate:\n    runs-on: ubuntu-\${{ matrix.os }}\n`;
    expect(checkWorkflow("ci.yml", text)).toHaveLength(1);
  });

  test("a uses job whose with.runs-on is not hosted fails", () => {
    const text = `jobs:\n  call:\n    uses: ./.github/workflows/other.yml\n    with:\n      runs-on: proxmox\n`;
    expect(checkWorkflow("ci.yml", text)).toHaveLength(1);
  });

  test("a uses job with no runs-on passes", () => {
    const text = `jobs:\n  call:\n    uses: ./.github/workflows/other.yml\n`;
    expect(checkWorkflow("ci.yml", text)).toEqual([]);
  });
});
