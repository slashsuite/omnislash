import type { ChangeEvent } from "react";
import { Button, Cluster, Select, Stack } from "@slashsuite/ui-react";
import { modelItems, move, nextModel } from "../lib/favorites.ts";

// OS-240: the Models page picks every model from Jacobus's T3 favourites instead of a text box, so a bare id (the
// cause of OS-239) cannot be typed. A chain is one dropdown row per model, added, removed and reordered by button.

/** One model, picked from the favourites. A stored model that is not one shows first, marked. */
export function ModelSelect({
  label,
  value,
  favourites,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  favourites: readonly string[];
  onChange: (model: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      disabled={disabled}
      size="sm"
      onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
      items={modelItems(favourites, value)}
    />
  );
}

/**
 * A fallback chain as rows of dropdowns, first model first. `name` names the chain in every control's label
 * (`Model 2 for job.nightly`), which is how a test or a screen reader finds it.
 */
export function ModelChain({
  name,
  chain,
  favourites,
  onChange,
  disabled,
}: {
  name: string;
  chain: readonly string[];
  favourites: readonly string[];
  onChange: (chain: string[]) => void;
  disabled?: boolean;
}) {
  const put = (i: number, model: string) => onChange(chain.map((m, j) => (j === i ? model : m)));
  return (
    <Stack gap="xs">
      {chain.map((model, i) => {
        const n = `model ${i + 1} for ${name}`;
        return (
          <Cluster key={i} gap="xs">
            <ModelSelect label={`Model ${i + 1} for ${name}`} value={model} favourites={favourites} onChange={(m) => put(i, m)} disabled={disabled} />
            <Button size="sm" variant="outline" aria-label={`Move ${n} up`} disabled={disabled || i === 0} onClick={() => onChange(move(chain, i, -1))}>
              ↑
            </Button>
            <Button size="sm" variant="outline" aria-label={`Move ${n} down`} disabled={disabled || i === chain.length - 1} onClick={() => onChange(move(chain, i, 1))}>
              ↓
            </Button>
            <Button size="sm" variant="outline" aria-label={`Remove ${n}`} disabled={disabled} onClick={() => onChange(chain.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </Cluster>
        );
      })}
      <Cluster gap="xs">
        <Button size="sm" variant="outline" aria-label={`Add a model to ${name}`} disabled={disabled || favourites.length === 0} onClick={() => onChange([...chain, nextModel(favourites, chain)])}>
          {chain.length === 0 ? "Add a model" : "Add a fallback"}
        </Button>
      </Cluster>
    </Stack>
  );
}
