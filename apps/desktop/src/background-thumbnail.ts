import { useEffect, useState } from "react";
import { backgroundImageProblem } from "@noren/model";
import type { Backend } from "@noren/model";

// The small preview of the picture a person is choosing (the settings screen and the dialog of a
// space), made from the same read the window uses: the backend reads the file and hands over the
// bytes, which become a `blob:` address that lives in this page. The page is never given a path or a
// web address to fetch. The address is let go when the path changes or the preview goes away.

/** What the preview has to show. */
export type ThumbnailState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "failed"; message: string };

const NONE: ThumbnailState = { status: "none" };
const LOADING: ThumbnailState = { status: "loading" };

/** The sentence for a person out of whatever a refused read rejects with (the Rust side sends text). */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The preview of the picture at `path`. An empty path, or one that cannot be a background
 * (`backgroundImageProblem`: the box that holds it tells why) has nothing to show and asks the
 * backend for nothing; any other is `loading` until the backend answers, then `ready` with the
 * address of the bytes, or `failed` with the sentence the backend gave.
 */
export function useBackgroundThumbnail(
  backend: Pick<Backend, "readBackgroundImage">,
  path: string,
): ThumbnailState {
  const usable =
    path.trim() !== "" && backgroundImageProblem(path) === undefined ? path : undefined;
  const [read, setRead] = useState<{ path: string; state: ThumbnailState }>();

  useEffect(() => {
    if (usable === undefined) return undefined;
    let current = true;
    let address: string | undefined;
    backend.readBackgroundImage(usable).then(
      (file) => {
        if (!current) return;
        address = URL.createObjectURL(new Blob([file.bytes.slice()], { type: file.mime }));
        setRead({ path: usable, state: { status: "ready", url: address } });
      },
      (error: unknown) => {
        if (current)
          setRead({ path: usable, state: { status: "failed", message: reasonOf(error) } });
      },
    );
    return () => {
      current = false;
      if (address !== undefined) URL.revokeObjectURL(address);
    };
  }, [backend, usable]);

  if (usable === undefined) return NONE;
  // An answer for another path is for a read that is out of date.
  return read !== undefined && read.path === usable ? read.state : LOADING;
}
