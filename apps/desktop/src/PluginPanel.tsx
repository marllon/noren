import { X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useT } from "./i18n";
import { currentPluginHost, usePluginPanel } from "./plugin-host";
import { PANEL_SANDBOX, panelDocument } from "./plugin-panel";

// The panel of a plugin (NOR-F18-01d): a side panel beside the terminal with the title the plugin
// gave, the name of the plugin and a frame that shows its content. The frame is the one place in
// the app that makes an iframe (the security guard names this file): `sandbox=""` gives it an
// opaque origin and takes away scripts, forms, windows and every way out, and its page carries its
// own policy (`plugin-panel.ts`). The page of the app cannot read it, and it cannot read the app.
// Nothing here runs unless a plugin that holds the permission `panel` asked for it, and the person
// can always close it.

/** Shows the panel a running plugin opened; renders nothing while there is none. */
export function PluginPanel() {
  const t = useT();
  const panel = usePluginPanel();
  if (panel === null) return null;
  const close = () => currentPluginHost()?.closePanel();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  };
  return (
    <aside
      className="plugin-panel"
      data-nr-part="plugin-panel"
      data-nr-plugin={panel.pluginId}
      aria-label={t("pluginPanel.label", { title: panel.title })}
      onKeyDown={onKeyDown}
    >
      <header className="plugin-panel-head">
        <h2>{panel.title}</h2>
        <span className="plugin-panel-from" data-nr-part="plugin-panel-from">
          {t("pluginPanel.from", { name: panel.pluginName })}
        </span>
        <button
          type="button"
          className="plugin-panel-close"
          aria-label={t("pluginPanel.close")}
          onClick={close}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <iframe
        className="plugin-panel-frame"
        data-nr-part="plugin-panel-frame"
        title={panel.title}
        sandbox={PANEL_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={panelDocument(panel.html)}
      />
    </aside>
  );
}
