import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Backend, Theme } from "@noren/model";
import { useConfigState } from "./config-store";
import { ConfirmDialog } from "./ConfirmDialog";
import { useT } from "./i18n";
import { importSchemeFile } from "./scheme-import";
import { Choice } from "./SettingsFields";
import { CHOICE_CONTROLS } from "./settings-controls";
import { themeChoiceOf } from "./theme-choice";
import { ThemeEditorDialog } from "./ThemeEditorDialog";
import { ThemeRenameDialog } from "./ThemeRenameDialog";
import { ThemeThumbnail } from "./ThemeThumbnail";
import {
  deleteUserThemeFile,
  duplicateUserTheme,
  exportUserThemeFile,
  isUserTheme,
  renameUserTheme,
  saveEditedTheme,
} from "./themes-section";
import type { Outcome, SaveMode } from "./themes-section";
import { chooseTheme } from "./use-theme";
import { addUserThemes, getUserThemes, useAllThemes } from "./user-themes-store";

/** The space the settings screen was opened over, which a theme can be used for on its own. */
export interface ThemesSpace {
  id: string;
  name: string;
  /** The theme the space has of its own, if any. */
  themeId: string | undefined;
}

type ThemesBackend = Pick<
  Backend,
  | "saveUserTheme"
  | "deleteUserTheme"
  | "exportUserTheme"
  | "pickBackgroundImage"
  | "readBackgroundImage"
>;

interface ThemesPanelProps {
  backend: ThemesBackend;
  /** The active space; without it the section only offers the whole app. */
  space?: ThemesSpace | undefined;
  /** Gives the active space the theme `themeId`, or (null) takes its own theme away. */
  onSpaceTheme?: ((themeId: string | null) => void) | undefined;
}

/** What the line under the gallery says: the sentence, and whether it is a problem. */
interface Said {
  text: string;
  alert: boolean;
}

/** Where the keyboard goes once a dialog closes or the gallery changes: a button of a card. */
type FocusTarget = { id: string; part: "pick" | "rename" | "edit" } | { part: "first" };

const said = (outcome: Outcome): Said => ({ text: outcome.message, alert: !outcome.ok });

/**
 * The themes section of the settings screen: a gallery of miniatures (the themes that ship with the
 * app, then the person's own), a click on one uses it for the whole app or only for the active
 * space, and a theme can be duplicated; one of the person's own can also be renamed, exported and
 * deleted, and a theme file can be imported. These act at once (they are files and the palette's own
 * choices) and are not part of the draft of the settings screen that Save keeps.
 */
export function ThemesPanel({ backend, space, onSpaceTheme }: ThemesPanelProps) {
  const t = useT();
  const themes = useAllThemes();
  const { config } = useConfigState();
  const panelRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const [scope, setScope] = useState<"app" | "space">("app");
  const [line, setLine] = useState<Said>({ text: "", alert: false });
  const [renaming, setRenaming] = useState<Theme>();
  const [deleting, setDeleting] = useState<Theme>();
  const [editing, setEditing] = useState<{ theme: Theme; own: boolean }>();
  const [focus, setFocus] = useState<FocusTarget>();

  const user = getUserThemes();
  const appChoice = themeChoiceOf(config, themes);
  const spaceOwn =
    space !== undefined && themes.some((theme) => theme.id === space.themeId)
      ? space.themeId
      : undefined;
  // The space a click is for, when the person chose "only this space".
  const target = scope === "space" ? space : undefined;
  const current = target !== undefined ? spaceOwn : (appChoice ?? undefined);

  useEffect(() => {
    if (focus === undefined) return;
    const cards = panelRef.current?.querySelectorAll<HTMLElement>('[data-nr-part="theme-card"]');
    const card =
      "id" in focus
        ? [...(cards ?? [])].find((element) => element.dataset["nrTheme"] === focus.id)
        : cards?.[0];
    const button =
      "id" in focus && focus.part !== "pick"
        ? card?.querySelector<HTMLElement>(`[data-nr-action="${focus.part}"]`)
        : card?.querySelector<HTMLElement>(".theme-pick");
    button?.focus();
    setFocus(undefined);
  }, [focus, themes]);

  const say = (outcome: Outcome) => setLine(said(outcome));

  const apply = async (theme: Theme) => {
    if (target !== undefined) {
      onSpaceTheme?.(theme.id);
      setLine({
        text: t("themes.appliedSpace", { name: theme.name, space: target.name }),
        alert: false,
      });
      return;
    }
    const problem = await chooseTheme(theme.id);
    setLine(
      problem === undefined
        ? { text: t("themes.appliedApp", { name: theme.name }), alert: false }
        : { text: t("themes.applyFailed", { reason: problem }), alert: true },
    );
  };

  /** "Follow the system" for the app; for a space, take its own theme away. */
  const useDefault = async () => {
    if (target !== undefined) {
      onSpaceTheme?.(null);
      setLine({ text: t("themes.appliedGlobal", { space: target.name }), alert: false });
      return;
    }
    const problem = await chooseTheme(null);
    setLine(
      problem === undefined
        ? { text: t("themes.appliedSystem"), alert: false }
        : { text: t("themes.applyFailed", { reason: problem }), alert: true },
    );
  };

  const duplicate = async (theme: Theme) => {
    const outcome = await duplicateUserTheme(backend, theme);
    say(outcome);
    if (outcome.theme !== undefined) setFocus({ id: outcome.theme.id, part: "pick" });
  };

  const rename = async (theme: Theme, name: string): Promise<string | undefined> => {
    const outcome = await renameUserTheme(backend, theme, name);
    if (!outcome.ok) return outcome.message;
    say(outcome);
    setRenaming(undefined);
    setFocus({ id: theme.id, part: "rename" });
    return undefined;
  };

  /** Saves what the editor made; answers why it was refused, or closes the editor and says what was saved. */
  const saveEdited = async (
    edited: Theme,
    name: string,
    mode: SaveMode,
  ): Promise<string | undefined> => {
    const outcome = await saveEditedTheme(backend, edited, name, mode);
    if (!outcome.ok) return outcome.message;
    say(outcome);
    setEditing(undefined);
    // A new theme has a card of its own; a theme saved over keeps its card, and its button.
    setFocus(
      outcome.theme !== undefined && mode === "new"
        ? { id: outcome.theme.id, part: "pick" }
        : { id: edited.id, part: "edit" },
    );
    return undefined;
  };

  const remove = async (theme: Theme) => {
    setDeleting(undefined);
    const outcome = await deleteUserThemeFile(backend, theme);
    say(outcome);
    // The card is gone: the keyboard goes to the first one. When the file stayed, it stays on its card.
    setFocus(outcome.ok ? { part: "first" } : { id: theme.id, part: "pick" });
  };

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file === undefined) return;
    setLine({ text: "", alert: false });
    void importSchemeFile(file, {
      backend,
      existing: getUserThemes(),
      added: addUserThemes,
    }).then((text) => setLine({ text, alert: false }));
    // So picking the same file again (after fixing it) is a change the input reports.
    input.value = "";
  };

  const kindLabel = (theme: Theme): string => t(`themes.kind.${theme.kind}`);

  return (
    <div className="themes-panel" data-nr-part="themes-panel" ref={panelRef}>
      <p className="settings-hint">{t("themes.hint")}</p>
      {space !== undefined && (
        <Choice<"app" | "space">
          control={CHOICE_CONTROLS.themeScope}
          legend={t("themes.scope")}
          hint={t("themes.scopeHint", { name: space.name })}
          name="themes-scope"
          value={scope}
          options={[
            { value: "app", label: t("themes.scopeApp") },
            { value: "space", label: t("themes.scopeSpace") },
          ]}
          onChange={setScope}
        />
      )}
      {target === undefined && spaceOwn !== undefined && space !== undefined && (
        <p className="settings-hint" data-nr-part="themes-space-override">
          {t("themes.spaceOverride", { name: space.name })}
        </p>
      )}
      <button
        type="button"
        className="settings-link"
        data-nr-part="themes-default"
        disabled={target !== undefined ? spaceOwn === undefined : appChoice === null}
        onClick={() => void useDefault()}
      >
        {target !== undefined ? t("themes.useGlobal") : t("themes.followSystem")}
      </button>
      <ul className="theme-gallery" aria-label={t("themes.list")} data-nr-part="theme-gallery">
        {themes.map((theme) => {
          const own = isUserTheme(theme, user);
          const inApp = appChoice === theme.id;
          const inSpace = spaceOwn === theme.id;
          return (
            <li
              key={theme.id}
              className="theme-card"
              data-nr-part="theme-card"
              data-nr-theme={theme.id}
              data-nr-origin={own ? "user" : "built-in"}
            >
              <button
                type="button"
                className="theme-pick"
                aria-pressed={current === theme.id}
                onClick={() => void apply(theme)}
              >
                <ThemeThumbnail theme={theme} />
                <span className="theme-name">{theme.name}</span>
              </button>
              <p className="settings-hint theme-meta">
                {kindLabel(theme)} · {t(own ? "themes.origin.yours" : "themes.origin.builtIn")}
              </p>
              {(inApp || inSpace) && (
                <p className="theme-tags">
                  {inApp && (
                    <span className="theme-tag" data-nr-part="theme-tag-app">
                      {t("themes.inUseApp")}
                    </span>
                  )}
                  {inSpace && (
                    <span className="theme-tag" data-nr-part="theme-tag-space">
                      {t("themes.inUseSpace")}
                    </span>
                  )}
                </p>
              )}
              <div className="theme-actions">
                <button
                  type="button"
                  className="settings-link"
                  data-nr-action="edit"
                  aria-label={t(own ? "themes.editTheme" : "themes.customizeTheme", {
                    name: theme.name,
                  })}
                  onClick={() => setEditing({ theme, own })}
                >
                  {t(own ? "themes.edit" : "themes.customize")}
                </button>
                <button
                  type="button"
                  className="settings-link"
                  data-nr-action="duplicate"
                  aria-label={t("themes.duplicateTheme", { name: theme.name })}
                  onClick={() => void duplicate(theme)}
                >
                  {t("themes.duplicate")}
                </button>
                {own && (
                  <>
                    <button
                      type="button"
                      className="settings-link"
                      data-nr-action="rename"
                      aria-label={t("themes.renameTheme", { name: theme.name })}
                      onClick={() => setRenaming(theme)}
                    >
                      {t("themes.rename")}
                    </button>
                    <button
                      type="button"
                      className="settings-link"
                      data-nr-action="export"
                      aria-label={t("themes.exportTheme", { name: theme.name })}
                      onClick={() => void exportUserThemeFile(backend, theme).then(say)}
                    >
                      {t("themes.export")}
                    </button>
                    <button
                      type="button"
                      className="settings-link"
                      data-nr-action="delete"
                      aria-label={t("themes.deleteTheme", { name: theme.name })}
                      onClick={() => setDeleting(theme)}
                    >
                      {t("themes.delete")}
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <button
        ref={importButtonRef}
        type="button"
        className="settings-link"
        data-nr-action="import"
        onClick={() => fileInputRef.current?.click()}
      >
        {t("themes.import")}
      </button>
      <p
        role={line.alert ? "alert" : "status"}
        className="settings-hint"
        data-nr-part="themes-status"
      >
        {line.text}
      </p>
      <input
        ref={fileInputRef}
        type="file"
        hidden
        tabIndex={-1}
        aria-label={t("themes.file")}
        data-nr-part="themes-file"
        onChange={onFile}
      />
      {renaming !== undefined &&
        createPortal(
          <StopEscape>
            <ThemeRenameDialog
              name={renaming.name}
              onRename={(name) => rename(renaming, name)}
              onCancel={() => {
                setFocus({ id: renaming.id, part: "rename" });
                setRenaming(undefined);
              }}
            />
          </StopEscape>,
          document.body,
        )}
      {editing !== undefined &&
        createPortal(
          <StopEscape>
            <ThemeEditorDialog
              source={editing.theme}
              own={editing.own}
              backend={backend}
              onSave={saveEdited}
              onCancel={() => {
                setFocus({ id: editing.theme.id, part: "edit" });
                setEditing(undefined);
              }}
            />
          </StopEscape>,
          document.body,
        )}
      {deleting !== undefined &&
        createPortal(
          <StopEscape>
            <ConfirmDialog
              title={t("themes.deleteTitle")}
              message={t("themes.deleteMessage", { name: deleting.name })}
              confirmLabel={t("themes.delete")}
              onConfirm={() => void remove(deleting)}
              onCancel={() => {
                setFocus({ id: deleting.id, part: "pick" });
                setDeleting(undefined);
              }}
            />
          </StopEscape>,
          document.body,
        )}
    </div>
  );
}

/**
 * A dialog of this section is a child of the settings screen in the React tree, whatever the page
 * it is drawn in, so its Escape would bubble up and close the screen too; this stops it here, after
 * the dialog has taken it.
 */
function StopEscape({ children }: { children: ReactNode }) {
  return (
    <div
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
    >
      {children}
    </div>
  );
}
