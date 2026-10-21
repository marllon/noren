import type { Id, LiveEntry } from "@noren/model";
import { t } from "./i18n";
import { liveKey } from "./tree-keys";
import type { RowProps } from "./SidebarTree";

interface LiveEntryRowsProps {
  groupId: Id;
  /** The depth of the group row; the entries sit one level in, where its tabs are. */
  depth: number;
  entries: readonly LiveEntry[];
  /** Why the source of the group failed the last time it was asked; the entries are the ones before. */
  error: string | undefined;
  rowProps: RowProps;
  onOpen(groupId: Id, key: string): void;
}

/**
 * The entries a live group lists (NOR-F17-04b), one row each under its header, and a quiet line when
 * its source failed. An entry is not a tab: it is no drag source, no tab of the group count and
 * not in the order of the switcher; clicking it opens it (shows its tab, or makes one). It is a
 * plain function of its props, so the sidebar test can read the rows it returns.
 */
export function LiveEntryRows({
  groupId,
  depth,
  entries,
  error,
  rowProps,
  onOpen,
}: LiveEntryRowsProps) {
  const indent = { marginInlineStart: (depth + 1) * 14 };
  return (
    <>
      {entries.map((entry) => (
        <li key={`live:${entry.key}`} role="none" style={indent}>
          <button
            type="button"
            className="live-entry"
            data-nr-part="live-entry"
            data-nr-depth={depth + 1}
            title={entry.cwd !== "" ? entry.cwd : undefined}
            {...rowProps(liveKey(groupId, entry.key))}
            onClick={() => onOpen(groupId, entry.key)}
          >
            <span className="live-entry-label" data-nr-part="live-entry-label">
              {entry.label}
            </span>
          </button>
        </li>
      ))}
      {error !== undefined && (
        <li key="live:error" role="none" style={indent}>
          <span className="live-error" data-nr-part="live-error" title={error}>
            {t("live.error", { reason: error })}
          </span>
        </li>
      )}
    </>
  );
}
