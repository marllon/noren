import { X } from "lucide-react";
import { useState } from "react";
import { pictureUrl } from "./background-image-store";
import type { PictureState } from "./background-image-store";

/**
 * The picture behind the terminals, covering the window, in three layers that take no clicks and
 * are drawn under everything else (the stylesheet gives them a negative layer): what the picture is
 * drawn on (the solid background of the theme), the picture itself, and the veil over it, the
 * background of the theme again, which keeps the text readable (a dark veil on a dark theme, a light
 * one on a light theme). The picture gets its address, opacity and blur from the
 * `--nr-background-*` variables of the root element. Nothing is drawn while there is no picture on screen.
 */
export function WindowBackground({ picture }: { picture: PictureState }) {
  if (pictureUrl(picture) === null) return null;
  return (
    <>
      <div
        className="window-background-backing"
        data-nr-part="background-backing"
        aria-hidden="true"
      />
      <div className="window-background" data-nr-part="background" aria-hidden="true" />
      <div className="window-background-veil" data-nr-part="background-veil" aria-hidden="true" />
    </>
  );
}

/**
 * The notice of a picture that cannot be shown (the file is gone, it is not a picture, the path is
 * refused). The window goes on without it; the notice floats over the content, never blocks it,
 * and closing it hides this sentence until it changes.
 */
export function BackgroundNotice({ picture }: { picture: PictureState }) {
  const message = picture.status === "failed" ? picture.message : "";
  const [dismissed, setDismissed] = useState("");
  if (message === "" || dismissed === message) return null;
  return (
    <div className="config-notice background-notice" role="status" data-nr-part="background-notice">
      <div className="config-notice-text">
        <span>The background image cannot be shown. {message}</span>
      </div>
      <button
        type="button"
        className="config-notice-close"
        aria-label="Dismiss"
        onClick={() => setDismissed(message)}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
