export function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <span
      aria-label="Coldsmoke"
      style={{
        fontSize: size,
        fontWeight: 300,
        letterSpacing: "var(--track-wide)",
        background:
          "linear-gradient(90deg, var(--silver-start), var(--silver-mid), var(--silver-end))",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
        whiteSpace: "nowrap",
      }}
    >
      COLDSMOKE
    </span>
  );
}
