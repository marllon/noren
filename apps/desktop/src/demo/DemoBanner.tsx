import { useT } from "../i18n";
import { DEMO_DOWNLOAD_URL } from "./demo-script";

/**
 * The strip above the app in the web demo: the shell is simulated, and the real app is a download
 * away. The address is text, not a link: the page code opens no link of its own (the guards in
 * `security-config.test.ts`), and the visitor copies it.
 */
export function DemoBanner() {
  const t = useT();
  return (
    <div className="demo-banner" role="note" data-nr-part="demo-banner">
      <span>{t("demo.banner")}</span>
      <span>
        <strong>{t("demo.download")}</strong>{" "}
        <code data-nr-part="demo-download-address">{DEMO_DOWNLOAD_URL}</code>
      </span>
    </div>
  );
}
