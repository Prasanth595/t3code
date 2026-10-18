import { useState } from "react";

/** MM-1101: the look of the portal on this device. style-inkwire.css keys off the root attribute. */
type PortalStyleName = "brutalist" | "inkwire";

const STYLE_KEY = "machine-map:style";

export function readPortalStyle(): PortalStyleName {
  try {
    return localStorage.getItem(STYLE_KEY) === "inkwire" ? "inkwire" : "brutalist";
  } catch {
    return "brutalist";
  }
}

export function applyPortalStyle(style: PortalStyleName): void {
  if (style === "inkwire") document.documentElement.dataset.style = "inkwire";
  else delete document.documentElement.dataset.style;
}

/** Keeps the choice on this device and shows it at once. */
export function setPortalStyle(style: PortalStyleName): void {
  try {
    localStorage.setItem(STYLE_KEY, style);
  } catch {
    // Private windows can refuse storage. The style then lasts until the page closes.
  }
  applyPortalStyle(style);
}

const OPTIONS: ReadonlyArray<{ readonly value: PortalStyleName; readonly label: string }> = [
  { value: "brutalist", label: "Neo-brutalist" },
  { value: "inkwire", label: "Inkwire" },
];

export function PortalStyle() {
  const [style, setStyle] = useState(readPortalStyle);

  const choose = (next: PortalStyleName) => {
    setPortalStyle(next);
    setStyle(next);
  };

  return (
    <>
      <h3>Style on this device</h3>
      <p className="small muted">
        Inkwire is the dark neon, hand-drawn look of the T3 Code theme of the same name.
      </p>
      <div className="actions">
        <div className="seg" role="group" aria-label="Portal style">
          {OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={style === option.value}
              onClick={() => choose(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
