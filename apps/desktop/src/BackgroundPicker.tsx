import { useState } from "react";
import type { Backend } from "@noren/model";
import { useBackgroundThumbnail, reasonOf } from "./background-thumbnail";
import type { ThumbnailState } from "./background-thumbnail";
import { useT } from "./i18n";

interface BackgroundPickerProps {
  backend: Pick<Backend, "pickBackgroundImage" | "readBackgroundImage">;
  /** The path the form holds now (empty: no picture). */
  path: string;
  /**
   * The reading of that path, when the screen that holds the picker already has it (the settings
   * screen tries the picture out in the window as soon as it can be read); without it the picker
   * reads the path itself.
   */
  reading?: ThumbnailState;
  /** Say the name of the file between the preview and the buttons (the glass settings screen does). */
  named?: boolean;
  /** The person chose a file in the chooser of the system. */
  onChoose(path: string): void;
  /** The person took away the picture the preview shows. */
  onRemove(): void;
}

/**
 * Where a picture is chosen: a preview of the file the form holds, a button that opens the file
 * chooser of the system and a button that takes the picture away. The boxes of the form keep taking
 * a path typed by hand. Closing the chooser without a choice changes nothing; a chooser that cannot
 * be opened says why under the buttons.
 */
export function BackgroundPicker({
  backend,
  path,
  reading,
  named = false,
  onChoose,
  onRemove,
}: BackgroundPickerProps) {
  const t = useT();
  // The last part of the path, which is what the person knows the picture by.
  const fileName =
    path
      .split(/[\\/]/)
      .filter((part) => part !== "")
      .pop() ?? "";
  const own = useBackgroundThumbnail(backend, reading === undefined ? path : "");
  const preview = reading ?? own;
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<string>();

  const choose = () => {
    setOpening(true);
    setFailure(undefined);
    backend
      .pickBackgroundImage({ title: t("background.pickTitle"), filter: t("background.pickFilter") })
      .then(
        (chosen) => {
          setOpening(false);
          if (chosen !== null) onChoose(chosen);
        },
        (error: unknown) => {
          setOpening(false);
          setFailure(t("background.pickFailed", { reason: reasonOf(error) }));
        },
      );
  };

  return (
    <div className="background-picker" data-nr-part="background-picker">
      <div className="background-thumb" data-nr-part="background-thumbnail-frame">
        {preview.status === "ready" ? (
          <img
            data-nr-part="background-thumbnail"
            src={preview.url}
            alt={t("background.thumbnailAlt")}
          />
        ) : (
          <span>
            {preview.status === "loading"
              ? t("background.thumbnailLoading")
              : t("background.thumbnailNone")}
          </span>
        )}
      </div>
      {named && (
        <div
          className="background-picker-info"
          data-nr-part="background-picker-name"
          title={path === "" ? undefined : path}
        >
          {fileName}
        </div>
      )}
      <div className="background-picker-buttons">
        <button
          type="button"
          className="settings-link"
          data-nr-part="background-choose"
          disabled={opening}
          onClick={choose}
        >
          {t("background.choose")}
        </button>
        <button
          type="button"
          className="settings-link"
          data-nr-part="background-remove"
          disabled={path.trim() === ""}
          onClick={onRemove}
        >
          {t("background.removeChosen")}
        </button>
      </div>
      {preview.status === "failed" && (
        <p
          className="settings-hint background-picker-note"
          data-nr-part="background-thumbnail-failure"
        >
          {t("background.thumbnailFailed", { reason: preview.message })}
        </p>
      )}
      {failure !== undefined && (
        <p className="settings-hint background-picker-note" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
