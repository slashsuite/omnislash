type Tone = "primary" | "danger" | "neutral";
export function Button({ tone = "primary", pressed, disabled, children, onClick }: { tone?: Tone; pressed?: boolean; disabled?: boolean; children: React.ReactNode; onClick?: () => void }) {
  const tones = { primary: "bg-violet-600 text-white", danger: "bg-red-600 text-white", neutral: "bg-zinc-100 text-zinc-900" };
  return (
    <button type="button" aria-pressed={pressed} disabled={disabled} onClick={onClick}
      className={`${tones[tone]} rounded-md px-4 py-2 ${pressed ? "ring-2 ring-violet-400" : ""} ${disabled ? "opacity-50" : ""}`}>
      {children}
    </button>
  );
}
