import type { FilePreview, Pane } from "@noren/model";
import { useEffect, useState } from "react";
import { useT } from "./i18n";
import { Markdown } from "./Markdown";
import { contentOf, loadPreview, previewTitle } from "./preview-view";
import type { PreviewContent, PreviewReader, PreviewState } from "./preview-view";

interface PreviewPaneProps {
  backend: PreviewReader;
  pane: Pane;
}

/** The path is on top, and under it what the file is: drawn by `PreviewView` from `contentOf`. */
interface PreviewViewProps {
  path: string;
  content: PreviewContent;
  /** The address of the picture in memory, once it has been made (`useImageUrl`). */
  imageUrl: string | undefined;
}

/**
 * The picture of a preview as an address the page can show: a `blob:` URL over the bytes of the file
 * (the policy of the app lets `img-src` take `blob:` and nothing from the network). The address lives
 * as long as the answer it was made for and is let go of when that changes or the pane goes away.
 */
function useImageUrl(preview: FilePreview | undefined): string | undefined {
  const [made, setMade] = useState<{ preview: FilePreview; url: string } | undefined>(undefined);
  useEffect(() => {
    if (preview?.kind !== "image") return undefined;
    const url = URL.createObjectURL(new Blob([preview.bytes.slice()], { type: preview.mime }));
    setMade({ preview, url });
    return () => {
      URL.revokeObjectURL(url);
      setMade((held) => (held?.url === url ? undefined : held));
    };
  }, [preview]);
  // An address made for an earlier answer is not shown for this one.
  return made !== undefined && made.preview === preview ? made.url : undefined;
}

/**
 * What a preview pane shows, from the content already decided. Drawn as React elements only: the
 * text of a file is a text node, markdown goes through the same parser as the answers of the AI (no
 * HTML, no link and no picture of its own), and a picture is an `<img>` of a `blob:` address.
 */
export function PreviewView({ path, content, imageUrl }: PreviewViewProps) {
  const t = useT();
  const name = previewTitle(path);
  let body;
  switch (content.type) {
    case "loading":
      body = (
        <p className="preview-note" role="status" data-nr-part="preview-note">
          {t("preview.loading")}
        </p>
      );
      break;
    case "empty":
      body = (
        <p className="preview-note" data-nr-part="preview-note">
          {t("preview.empty")}
        </p>
      );
      break;
    case "refused":
    case "failed":
      body = (
        <p
          className="preview-note preview-problem"
          role="alert"
          data-nr-part="preview-problem"
          data-nr-reason={content.type === "refused" ? content.reason : "failed"}
        >
          {content.message}
        </p>
      );
      break;
    case "markdown":
      body = (
        <div className="preview-markdown" data-nr-part="preview-markdown">
          <Markdown source={content.text} complete />
        </div>
      );
      break;
    case "text":
      body = (
        <>
          {content.warning !== undefined && (
            <p className="preview-warning" role="status" data-nr-part="preview-warning">
              {content.warning}
            </p>
          )}
          <pre className="preview-text" data-nr-part="preview-text">
            {content.text}
          </pre>
        </>
      );
      break;
    case "image":
      body =
        imageUrl === undefined ? null : (
          <img
            className="preview-image"
            data-nr-part="preview-image"
            src={imageUrl}
            alt={t("preview.imageAlt", { name })}
            draggable={false}
          />
        );
      break;
  }
  return (
    <div
      className="preview-pane"
      data-nr-part="preview-pane"
      role="group"
      aria-label={t("preview.pane")}
    >
      <h2 className="preview-path" data-nr-part="preview-path" title={path}>
        <span className="sr-only">{t("preview.path")}: </span>
        {path}
      </h2>
      <div
        className="preview-body"
        data-nr-part="preview-body"
        data-nr-kind={content.type}
        // The body scrolls, so the keyboard must be able to reach it.
        tabIndex={0}
        role="region"
        aria-label={t("preview.content", { name })}
      >
        {body}
      </div>
    </div>
  );
}

/**
 * A pane that shows a file: the path on top and the file under it. The file is read when the pane
 * is first drawn and again when its path changes, so what shows is what the file holds then. The
 * pane owns no session and starts no shell.
 */
export function PreviewPane({ backend, pane }: PreviewPaneProps) {
  const path = pane.path ?? "";
  const [read, setRead] = useState<{ path: string; state: PreviewState } | undefined>(undefined);
  useEffect(() => {
    let current = true;
    void loadPreview(backend, path).then((state) => {
      if (current) setRead({ path, state });
    });
    return () => {
      current = false;
    };
  }, [backend, path]);
  // The answer of an earlier path is not the answer for this one.
  const state: PreviewState = read?.path === path ? read.state : { status: "loading" };
  const imageUrl = useImageUrl(state.status === "ready" ? state.preview : undefined);
  return <PreviewView path={path} content={contentOf(state)} imageUrl={imageUrl} />;
}
