import { NOREN_DUSK } from "./builtin-themes";
import type { GalleryIndex } from "./gallery";

// The gallery `FakeBackend` serves until `setGalleryIndex` says otherwise (NOR-F18-02a): an index
// with two themes, a mod and a theme whose file does not match its hash, and the files behind the
// addresses. It is a fixture: nothing here is on the network, and `gallery-fixture.test.ts` holds
// every `sha256` to the text it hashes (the one of the item that does not match included, which is
// the point of it).

/** What an address serves, for `FakeBackend`: the text of the file and the sha256 of its bytes. */
export interface GalleryDownload {
  text: string;
  sha256: string;
}

const themeText = (id: string, name: string): string =>
  `${JSON.stringify({ ...NOREN_DUSK, id, name }, null, 2)}\n`;

export const FAKE_GALLERY_LAGOON = themeText("lagoon", "Lagoon");
export const FAKE_GALLERY_EMBER = themeText("ember", "Ember");
export const FAKE_GALLERY_TAMPERED = themeText("tampered", "Tampered");
export const FAKE_GALLERY_MOD = `/* Compact tabs: rounder, tighter tabs. */
[data-nr-part="item"] {
  border-radius: calc(var(--nr-radius) * 1.5);
}
`;

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** The sha256 of the bytes of each text above (UTF-8). */
export const FAKE_GALLERY_HASHES = {
  lagoon: "173a06f56cebf2d1d5d0a4af4aa8b9e87928d7541a1eaa851575eebf904139dd",
  ember: "bb9b715e5e52f99d64973eec308473d6909d4ce72bac54516cb6a94860bc934e",
  tampered: "8c65f56448bf868743764e42041dc4830e335234764be97953e443c34440f4a5",
  "compact-tabs": "5df2376c202e644fda4e6c85571d12b0d0df8b6f48fda3b74b5d3da37f7b1314",
} as const;

/** The index: the `tampered` item declares a hash that is not the hash of what its address serves. */
export const FAKE_GALLERY_INDEX: GalleryIndex = {
  version: 1,
  items: [
    {
      id: "lagoon",
      kind: "theme",
      name: "Lagoon",
      version: "1.1.0",
      url: "https://gallery.example/themes/lagoon.json",
      sha256: FAKE_GALLERY_HASHES.lagoon,
      size: byteLength(FAKE_GALLERY_LAGOON),
    },
    {
      id: "ember",
      kind: "theme",
      name: "Ember",
      version: "1.0.0",
      url: "https://gallery.example/themes/ember.json",
      sha256: FAKE_GALLERY_HASHES.ember,
      size: byteLength(FAKE_GALLERY_EMBER),
    },
    {
      id: "compact-tabs",
      kind: "mod",
      name: "Compact tabs",
      version: "1.0.0",
      url: "https://gallery.example/mods/compact-tabs.css",
      sha256: FAKE_GALLERY_HASHES["compact-tabs"],
      size: byteLength(FAKE_GALLERY_MOD),
    },
    {
      id: "tampered",
      kind: "theme",
      name: "Tampered",
      version: "1.0.0",
      url: "https://gallery.example/themes/tampered.json",
      // Not the hash of FAKE_GALLERY_TAMPERED: the file changed after the index was written.
      sha256: "0".repeat(64),
      size: byteLength(FAKE_GALLERY_TAMPERED),
    },
  ],
};

/** What each item's address serves, by item id. */
export const FAKE_GALLERY_DOWNLOADS: Readonly<Record<string, GalleryDownload>> = {
  lagoon: { text: FAKE_GALLERY_LAGOON, sha256: FAKE_GALLERY_HASHES.lagoon },
  ember: { text: FAKE_GALLERY_EMBER, sha256: FAKE_GALLERY_HASHES.ember },
  "compact-tabs": { text: FAKE_GALLERY_MOD, sha256: FAKE_GALLERY_HASHES["compact-tabs"] },
  tampered: { text: FAKE_GALLERY_TAMPERED, sha256: FAKE_GALLERY_HASHES.tampered },
};
