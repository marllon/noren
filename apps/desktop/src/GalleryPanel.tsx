import { useEffect, useRef, useState } from "react";
import { parseUserThemes } from "@noren/model";
import type { Backend, GalleryIndex, InstalledGalleryItem } from "@noren/model";
import { useT } from "./i18n";
import { setModFiles } from "./mods-store";
import { galleryRows, installedThemeProblem } from "./settings-gallery";
import type { GalleryRow } from "./settings-gallery";
import { setUserThemes } from "./user-themes-store";

type GalleryBackend = Pick<
  Backend,
  "galleryIndex" | "galleryInstalled" | "galleryInstall" | "listUserThemes" | "listMods"
>;

type View =
  | { state: "loading" }
  | { state: "failed"; reason: string }
  | { state: "ready"; index: GalleryIndex; installed: readonly InstalledGalleryItem[] };

/** What the last install of an item said: it worked, or why it did not. */
interface Note {
  text: string;
  alert: boolean;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The gallery, inside the settings screen: the index is read when the screen opens and set against
 * what the app installed from it. A new item has an Install button, one the index has a newer
 * version of has Update, and one that is up to date has none. After an install the installed list
 * and the themes or mods of the app are read again, so the item is in use without a restart. A
 * download or a hash that fails is said on the row of the item and nothing is installed.
 */
export function GalleryPanel({ backend }: { backend: GalleryBackend }) {
  const t = useT();
  const [view, setView] = useState<View>({ state: "loading" });
  const [busy, setBusy] = useState<string>();
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void Promise.all([backend.galleryIndex(), backend.galleryInstalled()]).then(
      ([index, installed]) => {
        if (alive.current) setView({ state: "ready", index, installed });
      },
      (error: unknown) => {
        if (alive.current) setView({ state: "failed", reason: reasonOf(error) });
      },
    );
    return () => {
      alive.current = false;
    };
  }, [backend]);

  const note = (id: string, next: Note | undefined) => {
    if (!alive.current) return;
    setNotes((current) => {
      const rest = Object.fromEntries(Object.entries(current).filter(([known]) => known !== id));
      return next === undefined ? rest : { ...rest, [id]: next };
    });
  };

  /** Reads back what the install changed: the installed list and the themes or mods in use. */
  const refresh = async (row: GalleryRow): Promise<string | undefined> => {
    const installed = await backend.galleryInstalled();
    if (alive.current) {
      setView((current) => (current.state === "ready" ? { ...current, installed } : current));
    }
    if (row.kind === "mod") {
      setModFiles(await backend.listMods());
      return undefined;
    }
    const texts = await backend.listUserThemes();
    setUserThemes(parseUserThemes(texts).themes);
    return installedThemeProblem(texts, row.id);
  };

  const install = async (row: GalleryRow) => {
    setBusy(row.id);
    note(row.id, undefined);
    try {
      await backend.galleryInstall(row.id);
    } catch (error) {
      note(row.id, {
        text: t("settings.galleryInstallFailed", { name: row.name, reason: reasonOf(error) }),
        alert: true,
      });
      if (alive.current) setBusy(undefined);
      return;
    }
    try {
      const problem = await refresh(row);
      note(
        row.id,
        problem === undefined
          ? { text: t("settings.galleryInstalledNow", { name: row.name }), alert: false }
          : {
              text: t("settings.galleryThemeInvalid", { name: row.name, reason: problem }),
              alert: true,
            },
      );
    } catch (error) {
      note(row.id, {
        text: t("settings.galleryRefreshFailed", { name: row.name, reason: reasonOf(error) }),
        alert: true,
      });
    }
    if (alive.current) setBusy(undefined);
  };

  if (view.state === "loading") {
    return (
      <p role="status" className="settings-hint" data-nr-part="settings-gallery-status">
        {t("settings.galleryLoading")}
      </p>
    );
  }
  if (view.state === "failed") {
    return (
      <p role="status" className="settings-hint" data-nr-part="settings-gallery-status">
        {t("settings.galleryFailed", { reason: view.reason })}
      </p>
    );
  }
  const rows = galleryRows(view.index, view.installed);
  if (rows.length === 0) {
    return <p className="settings-hint">{t("settings.galleryNone")}</p>;
  }
  return (
    <>
      <p className="settings-hint">{t("settings.galleryHint")}</p>
      <ul className="settings-gallery">
        {rows.map((row) => {
          const said = notes[row.id];
          return (
            <li key={row.id} className="settings-gallery-item" data-nr-part="settings-gallery-item">
              <div className="settings-gallery-text">
                <span className="settings-gallery-name">{row.name}</span>
                <span className="settings-hint">
                  {t(`settings.galleryKind.${row.kind}`)} · {t("settings.galleryVersion")}{" "}
                  {row.indexVersion}
                  {row.installedVersion !== undefined &&
                    ` · ${t("settings.galleryInstalledVersion")} ${row.installedVersion}`}
                </span>
                <span className="settings-hint" data-nr-part="settings-gallery-state">
                  {t(`settings.galleryState.${row.status}`)}
                </span>
              </div>
              {row.action !== undefined && (
                <button
                  type="button"
                  className="settings-link"
                  disabled={busy !== undefined}
                  aria-label={t(
                    row.action === "install"
                      ? "settings.galleryInstallItem"
                      : "settings.galleryUpdateItem",
                    { name: row.name },
                  )}
                  onClick={() => void install(row)}
                >
                  {t(
                    row.action === "install" ? "settings.galleryInstall" : "settings.galleryUpdate",
                  )}
                </button>
              )}
              {said !== undefined && (
                <p
                  role="status"
                  className={said.alert ? "settings-warning" : "settings-hint"}
                  data-nr-part="settings-gallery-note"
                >
                  {said.text}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
