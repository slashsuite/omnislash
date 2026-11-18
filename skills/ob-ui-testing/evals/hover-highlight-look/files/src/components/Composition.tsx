import { useState } from "react";

export type Box = { id: string; label: string; x: number; y: number; w: number; h: number };

export function Composition({ boxes }: { boxes: Box[] }) {
  const [focused, setFocused] = useState<string | null>(null);
  return (
    <div className="flex gap-4">
      <div className="relative h-80 w-80 border">
        {boxes.map((b) => (
          <div
            key={b.id}
            data-focused={focused === b.id}
            className={focused === b.id ? "absolute outline outline-2 outline-violet-500" : "absolute outline outline-1"}
            style={{ left: b.x, top: b.y, width: b.w, height: b.h, zIndex: focused === b.id ? 10 : 1 }}
            onMouseEnter={() => setFocused(b.id)}
            onMouseLeave={() => setFocused(null)}
          />
        ))}
      </div>
      <ul>
        {boxes.map((b) => (
          <li
            key={b.id}
            className={focused === b.id ? "bg-violet-100" : ""}
            onMouseEnter={() => setFocused(b.id)}
            onMouseLeave={() => setFocused(null)}
          >
            {b.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
