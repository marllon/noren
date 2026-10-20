import type { Backend } from "@noren/model";
import { ConfirmDialog } from "./ConfirmDialog";
import { useT } from "./i18n";
import { clearPendingLink, usePendingLink } from "./link-prompt";

/**
 * Asks before a link of the terminal is opened in the browser, with the address under the question
 * so the person sees where it goes. Draws nothing while no link waits.
 */
export function LinkPrompt({ backend }: { backend: Pick<Backend, "openExternal"> }) {
  const t = useT();
  const address = usePendingLink();
  if (address === null) return null;
  return (
    <ConfirmDialog
      title={t("openLink.title")}
      message={t("openLink.message")}
      detail={address}
      confirmLabel={t("openLink.confirm")}
      danger={false}
      onCancel={clearPendingLink}
      onConfirm={() => {
        clearPendingLink();
        backend.openExternal(address).catch(() => undefined);
      }}
    />
  );
}
