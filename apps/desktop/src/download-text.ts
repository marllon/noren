/**
 * Hands `text` to the system as a file named `fileName`: a Blob behind an anchor with the `download`
 * attribute, clicked and then dropped. Needs a document; the caller says what happened.
 */
export function downloadText(fileName: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked after the click has been taken: some webviews read the address a moment later.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
