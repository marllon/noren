import type { CSSProperties } from "react";
import type { Theme } from "@noren/model";

/**
 * A miniature of a theme drawn from its own colors: a title bar, a sidebar with an accent tab and
 * two quiet ones, and a terminal with a prompt, a line of text, the six colors of the ANSI palette
 * that tell a theme apart and the cursor. It is a picture and says nothing to a screen reader (the
 * card has the name); the colors reach the style sheet as custom properties.
 */
export function ThemeThumbnail({ theme }: { theme: Theme }) {
  const { ui, terminal } = theme;
  const style = {
    "--thumb-bg": ui.bg,
    "--thumb-surface": ui.surface,
    "--thumb-text": ui.text,
    "--thumb-muted": ui.muted,
    "--thumb-accent": ui.accent,
    "--thumb-border": ui.border,
    "--thumb-radius": `${Math.min(ui.radius, 8)}px`,
    "--thumb-term-bg": terminal.background,
    "--thumb-term-fg": terminal.foreground,
    "--thumb-cursor": terminal.cursor,
  } as CSSProperties;
  return (
    <span className="theme-thumb" aria-hidden="true" style={style} data-nr-part="theme-thumbnail">
      <span className="theme-thumb-title" />
      <span className="theme-thumb-body">
        <span className="theme-thumb-side">
          <span className="theme-thumb-tab theme-thumb-tab-on" />
          <span className="theme-thumb-tab" />
          <span className="theme-thumb-tab" />
        </span>
        <span className="theme-thumb-terminal">
          <span className="theme-thumb-line">
            <span className="theme-thumb-prompt" style={{ background: terminal.ansi[2] }} />
            <span className="theme-thumb-text" />
          </span>
          <span className="theme-thumb-line">
            <span className="theme-thumb-text theme-thumb-text-short" />
          </span>
          <span className="theme-thumb-colors">
            {[1, 2, 3, 4, 5, 6].map((index) => (
              <span key={index} style={{ background: terminal.ansi[index] }} />
            ))}
          </span>
          <span className="theme-thumb-line">
            <span className="theme-thumb-prompt" style={{ background: terminal.ansi[2] }} />
            <span className="theme-thumb-cursor" />
          </span>
        </span>
      </span>
    </span>
  );
}
