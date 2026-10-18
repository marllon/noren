import { PanelLeft } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Density, SidebarSide, TabsPlacement } from "./layout";
import { updateLayout, useLayout } from "./layout-store";

interface ChoiceProps<T extends string> {
  legend: string;
  name: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
}

function Choice<T extends string>({ legend, name, value, options, onChange }: ChoiceProps<T>) {
  return (
    <fieldset className="layout-field">
      <legend>{legend}</legend>
      {options.map((option) => (
        <label key={option.value} className="layout-option">
          <input
            type="radio"
            name={name}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

const SIDES: readonly { value: SidebarSide; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
];

const TAB_PLACEMENTS: readonly { value: TabsPlacement; label: string }[] = [
  { value: "sidebar", label: "In the sidebar" },
  { value: "top", label: "On top" },
];

const DENSITIES: readonly { value: Density; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

/**
 * Provisional control for the layout, in the title bar so it is reachable even when the sidebar is
 * hidden. The settings screen and the palette take over in NOR-F4-06c.
 */
export function LayoutControl() {
  const layout = useLayout();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // A press outside the control closes the panel.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div ref={rootRef} className="layout-control" onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        className="window-button layout-button"
        aria-label="Layout"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <PanelLeft size={14} aria-hidden="true" />
      </button>
      {open && (
        <div id={panelId} className="layout-panel" role="group" aria-label="Layout">
          <Choice
            legend="Sidebar side"
            name="layout-side"
            value={layout.side}
            options={SIDES}
            onChange={(side) => updateLayout({ side })}
          />
          <Choice
            legend="Tab position"
            name="layout-tabs"
            value={layout.tabs}
            options={TAB_PLACEMENTS}
            onChange={(tabs) => updateLayout({ tabs })}
          />
          <Choice
            legend="Density"
            name="layout-density"
            value={layout.density}
            options={DENSITIES}
            onChange={(density) => updateLayout({ density })}
          />
          {/* With top tabs the sidebar always hides (it holds the spaces and favorites). */}
          <label className="layout-option">
            <input
              type="checkbox"
              checked={layout.compact}
              disabled={layout.tabs === "top"}
              onChange={(event) => updateLayout({ compact: event.target.checked })}
            />
            <span>Compact mode</span>
          </label>
          <label className="layout-option">
            <input
              type="checkbox"
              checked={layout.keepOpen}
              disabled={!layout.compact || layout.tabs === "top"}
              onChange={(event) => updateLayout({ keepOpen: event.target.checked })}
            />
            <span>Keep sidebar open</span>
          </label>
        </div>
      )}
    </div>
  );
}
