import { FakeBackend, createBrowserPane } from "@noren/model";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserPane } from "./BrowserPane";
import { setLanguage } from "./i18n";

// Rendered to markup on the server side of React: what the pane is made of before anything is typed.
// What happens when the bar is submitted, the web view and the stacking are in e2e/browser-pane.spec.ts
// (they need a page with a layout).

const PAGE = "https://example.com/docs?page=2";

afterEach(() => setLanguage("en"));

const html = (visible: boolean, url: string = PAGE): string =>
  renderToStaticMarkup(
    <BrowserPane
      backend={new FakeBackend()}
      pane={createBrowserPane("p1", url)}
      visible={visible}
      onNavigate={() => undefined}
    />,
  );

describe("a browser pane", () => {
  it("is a group with an address bar holding its page and an area for the web view", () => {
    const markup = html(true);
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="Web page"');
    expect(markup).toMatch(/<input[^>]*aria-label="Address"/);
    expect(markup).toContain(`value="${PAGE}"`);
    expect(markup).toContain('data-nr-part="browser-view"');
  });

  it("says nothing is wrong before anything was typed", () => {
    const markup = html(true);
    expect(markup).toContain('aria-invalid="false"');
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain("aria-describedby");
  });

  it("marks its area shown or hidden by whether the pane is in view", () => {
    expect(html(true)).toContain('data-nr-state="shown"');
    expect(html(false)).toContain('data-nr-state="hidden"');
  });

  it("draws the address as text, whatever it holds", () => {
    // Not an address the pane may hold, but a state file or a test could put anything there.
    const markup = html(true, '"><img src=x onerror=alert(1)>');
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&quot;&gt;&lt;img");
  });

  it("speaks the language in force", () => {
    setLanguage("pt-BR");
    const markup = html(true);
    expect(markup).toContain('aria-label="Página web"');
    expect(markup).toMatch(/<input[^>]*aria-label="Endereço"/);
  });
});
