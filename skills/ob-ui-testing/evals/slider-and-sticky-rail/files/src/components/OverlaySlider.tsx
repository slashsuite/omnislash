import { useState } from "react";

export function OverlayCompare({ base, top }: { base: string; top: string }) {
  const [opacity, setOpacity] = useState(50);
  return (
    <div>
      <div className="relative">
        <img src={base} alt="Baseline" />
        <img src={top} alt="Branch" className="absolute inset-0" style={{ opacity: opacity / 100 }} />
      </div>
      <input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
    </div>
  );
}
