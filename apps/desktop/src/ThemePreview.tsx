import type { CSSProperties } from "react";
import { ANSI_INDEXES, BACKGROUND_VEIL, PICTURE_PANEL_OPACITY, safeFontFamily } from "@noren/model";
import type { Theme } from "@noren/model";

interface ThemePreviewProps {
  theme: Theme;
  /** The picture of the theme as an address the page can draw (`blob:`), or `null` while there is none on screen. */
  picture: string | null;
}

/** One piece of the sample text of the preview: a place of a color of the theme and a piece of a sentence, in the color the sample gives it (`selection`: on the color of the selection). */
type Piece = readonly [text: string, tone?: number | "selection"];

/** What the terminal of the preview says: a prompt, the output of a command and a line selected. */
const SAMPLE: readonly (readonly Piece[])[] = [
  [["~/noren ", 6], ["main ", 5], ["$ ", 2], ["git status"]],
  [["On branch main"]],
  [["modified:", 1], [" src/theme.ts"]],
  [["new file:", 2], [" src/editor.ts"]],
  [["warning:", 3], [" "], ["2 files", 4], [" skipped"]],
  [["select this text", "selection"], [" => != >= ->"]],
];

/**
 * A word of the sample. It is drawn as generated content of the style sheet, not as text of the
 * page: the preview is a picture of the colors of the person (a low contrast in it is their choice,
 * and the editor warns about it), not words of the interface that a screen reader reads or a
 * contrast check holds to a minimum.
 */
function Word({
  text,
  className,
  color,
}: {
  text: string;
  className?: string | undefined;
  color?: string | undefined;
}) {
  return (
    <span
      className={className}
      data-text={text}
      style={color !== undefined ? { color } : undefined}
    />
  );
}

/**
 * What stands for the desktop (or the effect of the system) behind a window that lets it through: a
 * gradient of colors of its own, the same for every theme, so the transparency of the panels can be seen.
 */
const BACKDROP = "linear-gradient(135deg, #5c7fa8, #a8648c 55%, #d6a24a)";

/** `#rrggbb` at `opacity` as a CSS color, so the panels of the preview let what is behind them through. */
function glass(color: string, opacity: number): string {
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16));
  return `rgb(${r} ${g} ${b} / ${Math.round(opacity * 1000) / 1000})`;
}

/**
 * The theme as a small window of its own: a title bar, a sidebar with an accent tab and two quiet
 * ones, and a terminal with lines in the colors of the palette, the selection, the cursor and the
 * whole palette of sixteen swatches, drawn in the font, the corners and the transparency the theme
 * says. The picture of the theme, when there is one, shows behind the terminal under the veil of the
 * window, and the panels let it through the way the window does (`PICTURE_PANEL_OPACITY`); without a
 * picture they are as opaque as `ui.opacity` says, over a backdrop that stands for the effect of the
 * system behind the window. All of it comes from the theme given, as custom properties of the
 * element, so the colors of the window around it never change what it shows. It is a picture and
 * says nothing to a screen reader (its words are only a sample, and the boxes beside it hold every
 * value it shows).
 */
export function ThemePreview({ theme, picture }: ThemePreviewProps) {
  const { ui, terminal, font, background } = theme;
  const panelOpacity = picture !== null ? PICTURE_PANEL_OPACITY : ui.opacity;
  const style: Record<string, string> = {
    "--tp-backdrop": BACKDROP,
    "--tp-bg": ui.bg,
    "--tp-surface": ui.surface,
    "--tp-text": ui.text,
    "--tp-muted": ui.muted,
    "--tp-accent": ui.accent,
    "--tp-border": ui.border,
    "--tp-radius": `${ui.radius}px`,
    "--tp-panel-blur": `${ui.blur}px`,
    // What the window is painted on: its solid background under a picture, else the background at the opacity of the theme.
    "--tp-backing": picture !== null ? ui.bg : glass(ui.bg, panelOpacity),
    "--tp-surface-glass": glass(ui.surface, panelOpacity),
    "--tp-term-bg": terminal.background,
    "--tp-term-glass": glass(terminal.background, picture !== null ? panelOpacity : 1),
    "--tp-term-fg": terminal.foreground,
    "--tp-cursor": terminal.cursor,
    "--tp-selection": terminal.selection,
    "--tp-font": safeFontFamily(font.family),
    "--tp-font-size": `${font.size}px`,
    "--tp-line-height": String(font.lineHeight),
    "--tp-ligatures": font.ligatures ? "normal" : "none",
    "--tp-picture": picture !== null ? `url("${picture}")` : "none",
    "--tp-picture-opacity": String(background.opacity),
    "--tp-picture-blur": `${background.blur ?? 0}px`,
    "--tp-veil": String(BACKGROUND_VEIL),
  };
  terminal.ansi.forEach((color, index) => {
    style[`--tp-ansi-${index}`] = color;
  });

  return (
    <div
      className="theme-preview"
      data-nr-part="theme-preview"
      data-nr-picture={picture !== null ? "shown" : "none"}
      aria-hidden="true"
      style={style as CSSProperties}
    >
      <div className="tp-window">
        {picture !== null && (
          <>
            <div className="tp-picture" />
            <div className="tp-veil" />
          </>
        )}
        <div className="tp-title">
          <span className="tp-dot" />
          <Word text="Noren" />
        </div>
        <div className="tp-body">
          <div className="tp-side">
            <Word text="Tab 1" className="tp-tab tp-tab-on" />
            <Word text="build" className="tp-tab" />
            <Word text="notes" className="tp-tab" />
          </div>
          <div className="tp-terminal">
            {SAMPLE.map((line, at) => (
              <div key={at} className="tp-line">
                {line.map(([text, tone], index) => (
                  <Word
                    key={index}
                    text={text}
                    className={tone === "selection" ? "tp-selection" : undefined}
                    color={typeof tone === "number" ? `var(--tp-ansi-${tone})` : undefined}
                  />
                ))}
              </div>
            ))}
            <div className="tp-line">
              <Word text="$ " color="var(--tp-ansi-2)" />
              <span className="tp-cursor" />
            </div>
            <div className="tp-palette" aria-hidden="true">
              {ANSI_INDEXES.map((index) => (
                <span
                  key={index}
                  className="tp-swatch"
                  style={{ background: `var(--tp-ansi-${index})` }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
