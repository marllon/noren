import { afterEach, describe, expect, it } from "vitest";
import { en } from "./en";
import {
  DICTIONARIES,
  applyLanguageSetting,
  getLanguage,
  resolveLanguage,
  setLanguage,
  t,
  tabCount,
  translate,
} from "./index";
import { configJsonSchema } from "@noren/model";
import {
  actionIsNamed,
  actionName,
  categoryName,
  effectName,
  fieldDescription,
  spaceColorName,
  spaceIconName,
} from "./names";
import { ACTIONS } from "../keybindings";
import { ptBR } from "./pt-BR";

const placeholdersOf = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();

afterEach(() => setLanguage("en"));

describe("the dictionaries", () => {
  it("have the same keys in both languages", () => {
    expect(Object.keys(ptBR).sort()).toEqual(Object.keys(en).sort());
  });

  it("have a text for every key", () => {
    for (const [language, dictionary] of Object.entries(DICTIONARIES)) {
      for (const [key, text] of Object.entries(dictionary)) {
        expect(text.trim(), `${language} ${key}`).not.toBe("");
      }
    }
  });

  it("fill in the same placeholders in both languages", () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholdersOf(ptBR[key]), key).toEqual(placeholdersOf(en[key]));
    }
  });

  it("write Portuguese with its accents", () => {
    expect(ptBR["titleBar.settings"]).toBe("Configurações");
    expect(ptBR["window.content"]).toBe("Conteúdo");
  });
});

describe("resolveLanguage", () => {
  it("takes the language of the system when the setting is system or missing", () => {
    expect(resolveLanguage("system", "pt-BR")).toBe("pt-BR");
    expect(resolveLanguage(undefined, "pt-BR")).toBe("pt-BR");
    expect(resolveLanguage("system", "en-US")).toBe("en");
    expect(resolveLanguage("system", "PT-br")).toBe("pt-BR");
  });

  it("reads another Portuguese as the Brazilian one", () => {
    expect(resolveLanguage("system", "pt")).toBe("pt-BR");
    expect(resolveLanguage("system", "pt-PT")).toBe("pt-BR");
  });

  it("uses a language the person chose, whatever the system says", () => {
    expect(resolveLanguage("en", "pt-BR")).toBe("en");
    expect(resolveLanguage("pt-BR", "en-US")).toBe("pt-BR");
    expect(resolveLanguage("pt-BR", undefined)).toBe("pt-BR");
  });

  it("falls back to English for a language Noren does not have", () => {
    expect(resolveLanguage("system", "fr-FR")).toBe("en");
    expect(resolveLanguage("system", undefined)).toBe("en");
    expect(resolveLanguage("system", "")).toBe("en");
    expect(resolveLanguage("klingon", "pt-BR")).toBe("en");
  });
});

describe("translate", () => {
  it("says a text in each language", () => {
    expect(translate("en", "titleBar.settings")).toBe("Settings");
    expect(translate("pt-BR", "titleBar.settings")).toBe("Configurações");
  });

  it("fills in the parameters", () => {
    expect(translate("en", "tree.tabDefault", { n: 3 })).toBe("Tab 3");
    expect(translate("pt-BR", "tree.tabDefault", { n: 3 })).toBe("Aba 3");
    expect(translate("pt-BR", "menu.moveTo", { name: "Trabalho" })).toBe("Mover para Trabalho");
  });

  it("fills in a parameter that appears twice, and leaves one without a value as it is", () => {
    expect(
      translate("en", "shortcuts.conflict", { chord: "Ctrl+T", holders: '"A"', title: "B" }),
    ).toBe('Ctrl+T is already used by "A". "B" keeps its shortcut; nothing changed.');
    expect(translate("en", "tree.tabDefault", {})).toBe("Tab {n}");
  });

  it("gives the English text for a language it does not have", () => {
    expect(translate("fr", "titleBar.settings")).toBe("Settings");
    expect(translate("toString", "titleBar.settings")).toBe("Settings");
  });
});

describe("the language in force", () => {
  it("is English until it is told otherwise", () => {
    expect(getLanguage()).toBe("en");
    expect(t("window.newTab")).toBe("New tab");
  });

  it("changes the texts of t, with the parameters", () => {
    setLanguage("pt-BR");
    expect(t("window.newTab")).toBe("Nova aba");
    expect(t("spaceMenu.label", { name: "Casa" })).toBe("Opções de Casa");
    expect(tabCount(1)).toBe("1 aba");
    expect(tabCount(4)).toBe("4 abas");
  });

  it("follows a setting of the file", () => {
    applyLanguageSetting("pt-BR");
    expect(getLanguage()).toBe("pt-BR");
    applyLanguageSetting("en");
    expect(getLanguage()).toBe("en");
    // The language of the computer running the tests must not leak in: no `navigator` is read here.
    applyLanguageSetting("klingon");
    expect(getLanguage()).toBe("en");
  });

  it("sets the language of the page", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    const page = { documentElement: { lang: "" } };
    Object.defineProperty(globalThis, "document", { value: page, configurable: true });
    try {
      applyLanguageSetting("pt-BR");
      expect(page.documentElement.lang).toBe("pt-BR");
      applyLanguageSetting("en");
      expect(page.documentElement.lang).toBe("en");
    } finally {
      if (original) Object.defineProperty(globalThis, "document", original);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });
});

describe("the names of things known by id", () => {
  it("name every action of the registry", () => {
    for (const action of ACTIONS) expect(actionIsNamed(action.id), action.id).toBe(true);
  });

  it("say the English title of the registry in English", () => {
    for (const action of ACTIONS) expect(actionName(action.id, action.title)).toBe(action.title);
  });

  it("say the actions in Portuguese, with their directions and digits", () => {
    setLanguage("pt-BR");
    expect(actionName("tab.new", "New tab")).toBe("Nova aba");
    expect(actionName("pane.focus-left", "Focus pane left")).toBe("Focar o painel à esquerda");
    expect(actionName("space.3", "Go to space 3")).toBe("Ir para o espaço 3");
    expect(actionName("tab.9", "Go to tab 9")).toBe("Ir para a aba 9");
    expect(categoryName("Panes")).toBe("Painéis");
    expect(effectName("none")).toBe("Nenhum");
  });

  it("give the title of the registry to an action the dictionary does not know", () => {
    expect(actionName("future.thing", "Do the thing")).toBe("Do the thing");
  });
});

/** Every described field of the generated JSON Schema, by the path the dictionary names it with. */
function schemaDescriptions(): Map<string, string> {
  type Node = {
    description?: string;
    properties?: Record<string, Node>;
    items?: Node;
    // The kinds of an entry of a list (the shell and the SSH profile): their fields are the fields
    // of the entry, so a field both kinds have is described once, in the same words.
    oneOf?: Node[];
  };
  const found = new Map<string, string>();
  const walk = (node: Node, path: string[]): void => {
    if (node.description !== undefined) {
      const key = path.join(".") || "root";
      const before = found.get(key);
      if (before !== undefined) expect(node.description, key).toBe(before);
      found.set(key, node.description);
    }
    for (const [name, child] of Object.entries(node.properties ?? {})) walk(child, [...path, name]);
    if (node.items !== undefined) walk(node.items, [...path, "item"]);
    for (const kind of node.oneOf ?? []) walk(kind, path);
  };
  walk(configJsonSchema() as Node, []);
  return found;
}

describe("the descriptions of the fields of config.jsonc", () => {
  it("are in the dictionary, word for word in English, for every described field of the schema", () => {
    for (const [path, description] of schemaDescriptions()) {
      expect(Object.hasOwn(en, `field.${path}`), path).toBe(true);
      expect(fieldDescription(path), path).toBe(description);
    }
  });

  it("have no entry for a field the schema does not describe", () => {
    const described = schemaDescriptions();
    for (const key of Object.keys(en)) {
      if (key.startsWith("field.")) expect(described.has(key.slice(6)), key).toBe(true);
    }
  });

  it("are said in Portuguese by the id of the field", () => {
    setLanguage("pt-BR");
    for (const path of schemaDescriptions().keys()) {
      expect(fieldDescription(path), path).not.toBe(en[`field.${path}` as keyof typeof en]);
    }
    expect(fieldDescription("appearance.sidebar.position")).toBe(
      "Em que lado da janela fica a barra lateral.",
    );
  });

  it("are empty for a path with none", () => {
    expect(fieldDescription("appearance.nothing")).toBe("");
  });
});

describe("the names of the colors and icons of a space", () => {
  it("are said in the language in force and fall back to the given name", () => {
    expect(spaceColorName("Blue")).toBe("Blue");
    expect(spaceIconName("book-open", "Book")).toBe("Book");
    setLanguage("pt-BR");
    expect(spaceColorName("Blue")).toBe("Azul");
    expect(spaceIconName("book-open", "Book")).toBe("Livro");
    expect(spaceColorName("Unknown")).toBe("Unknown");
    expect(spaceIconName("unknown", "Mystery")).toBe("Mystery");
  });
});
