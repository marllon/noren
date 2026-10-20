import { browserUrlProblem } from "@noren/model";
import { afterEach, describe, expect, it } from "vitest";
import { addressProblemText, browserTitle, readAddress } from "./browser-address";
import { setLanguage, translate } from "./i18n";

afterEach(() => setLanguage("en"));

describe("reading what was typed in the address bar", () => {
  it("takes a page the pane may show, without the blanks around it", () => {
    expect(readAddress("  https://example.com/a?b=1#c \n")).toEqual({
      ok: true,
      url: "https://example.com/a?b=1#c",
    });
    expect(readAddress("http://localhost:3000/")).toEqual({
      ok: true,
      url: "http://localhost:3000/",
    });
  });

  it.each([
    "file:///C:/Windows/win.ini",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<p>hi</p>",
    "noren://open",
    "about:blank",
    "blob:https://example.com/x",
    "http://tauri.localhost/",
    "https://ipc.localhost./",
    "https://good.example@evil.example/",
    "example.com",
    "https://",
    "",
    "   ",
  ])("refuses %j with the reason the model gives", (text) => {
    const reading = readAddress(text);
    expect(reading.ok).toBe(false);
    expect(reading.ok ? undefined : reading.problem).toBe(browserUrlProblem(text.trim()));
  });
});

describe("the reason in words", () => {
  const texts = [
    "https://".repeat(1) + "x".repeat(3000),
    "file:///C:/x",
    "https://a b.example/",
    "https://",
    "https://good.example@evil.example/",
    "https://a%2Eb/",
    "http://tauri.localhost/",
    "",
  ];

  it("says every reason the model can give in both languages, never the English one raw", () => {
    const problems = new Set(texts.map((text) => browserUrlProblem(text)));
    expect(problems.size).toBe(7);
    for (const problem of problems) {
      expect(problem).toBeDefined();
      for (const language of ["en", "pt-BR"] as const) {
        setLanguage(language);
        const said = addressProblemText(problem ?? "");
        expect(said, `${language}: ${problem}`).not.toBe(problem);
        expect(said, `${language}: ${problem}`).not.toMatch(/\{\w+\}/);
        expect(said, `${language}: ${problem}`).not.toBe(
          translate(language, "browser.problem.other", { reason: problem ?? "" }),
        );
      }
    }
  });

  it("speaks Portuguese when the language says so", () => {
    setLanguage("pt-BR");
    expect(addressProblemText(browserUrlProblem("file:///C:/x") ?? "")).toBe(
      "Só endereços http e https podem ser mostrados.",
    );
  });

  it("shows a reason it does not know as it came, in a sentence of the interface", () => {
    expect(addressProblemText("some new reason")).toBe(
      "This address cannot be shown: some new reason",
    );
    // A reason that is the name of something on Object does not find a text there.
    expect(addressProblemText("constructor")).toBe("This address cannot be shown: constructor");
  });
});

describe("the title of a browser pane", () => {
  it("is the host of its page, with the port", () => {
    expect(browserTitle("https://example.com/docs?a=1")).toBe("example.com");
    expect(browserTitle("http://localhost:3000/x")).toBe("localhost:3000");
  });

  it("is a plain word for a pane with no page, and the text itself when it has no host", () => {
    expect(browserTitle(undefined)).toBe("Web page");
    expect(browserTitle("not an address")).toBe("not an address");
  });
});
