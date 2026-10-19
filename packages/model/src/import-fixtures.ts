// Files for the tests of the importers, written for them: one color scheme ("Lagoon", a dark one)
// in each format the importers read, a settings file with profiles, and files that are not valid.
// The e2e tests upload the same texts. Nothing here is a copy of anybody's scheme.

/** The colors of the "Lagoon" scheme, as `[red, green, blue]` from 0 to 255. */
const LAGOON = {
  background: [16, 24, 32],
  foreground: [214, 226, 238],
  cursor: [242, 193, 78],
  selection: [43, 63, 85],
  ansi: [
    [27, 38, 49],
    [229, 89, 109],
    [110, 201, 138],
    [232, 195, 90],
    [90, 163, 232],
    [181, 131, 224],
    [78, 201, 192],
    [199, 211, 223],
    [70, 88, 107],
    [255, 122, 140],
    [142, 230, 168],
    [255, 217, 122],
    [127, 188, 255],
    [207, 163, 245],
    [116, 227, 218],
    [244, 248, 251],
  ],
} as const;

/** `[26, 38, 49]` as `#1a2631`. */
const hex = (rgb: readonly number[]): string =>
  `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;

/** The entry of one color in a property list, the way a color file lays it out. */
function plistColor(name: string, rgb: readonly number[], alpha = 1): string {
  const [red = 0, green = 0, blue = 0] = rgb;
  return `\t<key>${name}</key>
\t<dict>
\t\t<key>Alpha Component</key>
\t\t<real>${alpha}</real>
\t\t<key>Blue Component</key>
\t\t<real>${blue / 255}</real>
\t\t<key>Color Space</key>
\t\t<string>sRGB</string>
\t\t<key>Green Component</key>
\t\t<real>${green / 255}</real>
\t\t<key>Red Component</key>
\t\t<real>${red / 255}</real>
\t</dict>
`;
}

/** An XML property list with the colors of a scheme (`only` limits it to the keys named). */
export function plistScheme(only?: (key: string) => boolean): string {
  const entries: [string, readonly number[], number?][] = [
    ...LAGOON.ansi.map((rgb, index): [string, readonly number[]] => [`Ansi ${index} Color`, rgb]),
    ["Background Color", LAGOON.background],
    ["Bold Color", [255, 255, 255]],
    ["Cursor Color", LAGOON.cursor],
    ["Cursor Text Color", LAGOON.background],
    ["Foreground Color", LAGOON.foreground],
    ["Selected Text Color", LAGOON.foreground],
    ["Selection Color", LAGOON.selection],
  ];
  const body = entries
    .filter(([key]) => only === undefined || only(key))
    .map(([key, rgb, alpha]) => plistColor(key, rgb, alpha))
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}</dict>
</plist>
`;
}

/** The colors of "Lagoon" in the order the importers fill a theme, for the tests to compare with. */
export const LAGOON_COLORS = {
  background: hex(LAGOON.background),
  foreground: hex(LAGOON.foreground),
  cursor: hex(LAGOON.cursor),
  selection: hex(LAGOON.selection),
  ansi: LAGOON.ansi.map(hex),
};

/** "Lagoon" as an XML property list. */
export const PLIST_LAGOON = plistScheme();

/** The same property list with a color missing (ANSI color 3). */
export const PLIST_MISSING_COLOR = plistScheme((key) => key !== "Ansi 3 Color");

/** A property list cut off in the middle of an element. */
export const PLIST_TRUNCATED = PLIST_LAGOON.slice(0, 700);

/** The start of a binary property list. */
export const PLIST_BINARY = "bplist00\u0001\u0002\u0003";

/** "Lagoon" as the text format of one `key = value` per line, with comments and other keys. */
export const KEY_VALUE_LAGOON = `# A dark scheme, written for the tests
palette = 0=${hex(LAGOON.ansi[0])}
palette = 1=${hex(LAGOON.ansi[1])}
palette = 2=${hex(LAGOON.ansi[2])}
palette = 3=${hex(LAGOON.ansi[3])}
palette = 4=${hex(LAGOON.ansi[4])}
palette = 5=${hex(LAGOON.ansi[5])}
palette = 6=${hex(LAGOON.ansi[6])}
palette = 7=${hex(LAGOON.ansi[7])}
palette = 8=${hex(LAGOON.ansi[8])}
palette = 9=${hex(LAGOON.ansi[9])}
palette = 10=${hex(LAGOON.ansi[10])}
palette = 11=${hex(LAGOON.ansi[11])}
palette = 12=${hex(LAGOON.ansi[12])}
palette = 13=${hex(LAGOON.ansi[13])}
palette = 14=${hex(LAGOON.ansi[14])}
palette = 15=${hex(LAGOON.ansi[15])}
palette = 100=#123456

background = ${hex(LAGOON.background)}
foreground = ${hex(LAGOON.foreground)}
cursor-color = ${hex(LAGOON.cursor)}
cursor-text = ${hex(LAGOON.background)}
selection-background = ${hex(LAGOON.selection)}
selection-foreground = ${hex(LAGOON.foreground)}
`;

/** The same with a color that is not one. */
export const KEY_VALUE_BAD_COLOR = KEY_VALUE_LAGOON.replace(
  `foreground = ${hex(LAGOON.foreground)}`,
  "foreground = lagoon-blue",
);

/** The same without the background. */
export const KEY_VALUE_NO_BACKGROUND = KEY_VALUE_LAGOON.replace(
  `background = ${hex(LAGOON.background)}\n`,
  "",
);

/** One scheme of a settings file, as an object text, with the colors by name. */
function jsonScheme(name: string, drop?: string): string {
  const names = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "purple",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightPurple",
    "brightCyan",
    "brightWhite",
  ];
  const lines = [
    `"name": "${name}"`,
    `"foreground": "${hex(LAGOON.foreground)}"`,
    `"background": "${hex(LAGOON.background)}"`,
    `"cursorColor": "${hex(LAGOON.cursor)}"`,
    `"selectionBackground": "${hex(LAGOON.selection)}"`,
    ...names.map((color, index) => `"${color}": "${hex(LAGOON.ansi[index] ?? [0, 0, 0])}"`),
  ].filter((line) => drop === undefined || !line.startsWith(`"${drop}"`));
  return `{\n      ${lines.join(",\n      ")},\n    }`;
}

/**
 * A settings file with comments, trailing commas, profiles (one of them hidden) and three
 * schemes: "Lagoon", one with a color missing ("Broken") and one named like a built-in theme.
 */
export const JSON_SETTINGS = `// Settings of some terminal, with comments, as people keep them.
{
  "defaultProfile": "{1b2c3d4e-0000-4000-8000-000000000001}",
  /* The profiles */
  "profiles": {
    "defaults": { "fontSize": 11 },
    "list": [
      {
        "guid": "{1b2c3d4e-0000-4000-8000-000000000001}",
        "name": "Command Prompt",
        "commandline": "cmd.exe",
        "startingDirectory": "%USERPROFILE%",
        "colorScheme": "Lagoon",
      },
      {
        "guid": "{1b2c3d4e-0000-4000-8000-000000000002}",
        "name": "Hidden Shell",
        "commandline": "hidden.exe",
        "hidden": true,
      },
      {
        "guid": "{1b2c3d4e-0000-4000-8000-000000000003}",
        "name": "Dev Shell",
        "commandline": "pwsh.exe -NoLogo",
        "hidden": false,
      },
      { "guid": "{1b2c3d4e-0000-4000-8000-000000000004}", "name": "No Command" },
      { "guid": "{1b2c3d4e-0000-4000-8000-000000000005}" },
    ],
  },
  "schemes": [
    ${jsonScheme("Lagoon")},
    ${jsonScheme("Broken", "red")},
    ${jsonScheme("Noren Dusk")},
  ],
}
`;

/** A string as JSON text, so a command line with quotes and backslashes can be written readably. */
const q = (text: string): string => JSON.stringify(text);

/**
 * A settings file for the tests of importing profiles: comments and trailing commas, a command line
 * with a quoted program and one with a quoted argument that holds spaces and quotes of its own, a
 * profile that is hidden, one with no command line, one named like a shell the tests seed as
 * detected (`Git Bash`, `Fake`), and two with the same name.
 */
export const JSON_PROFILES_FILE = `// Profiles of some terminal, with comments, as people keep them.
{
  "profiles": {
    "defaults": { "fontSize": 11 },
    /* The shells */
    "list": [
      {
        "name": "Git Bash",
        "commandline": ${q('"C:\\Program Files\\Git\\bin\\bash.exe" --login -i')},
        "startingDirectory": "%USERPROFILE%",
        "colorScheme": "Lagoon",
      },
      {
        "name": "Dev Shell",
        "commandline": ${q("pwsh.exe -NoLogo -Command \"Set-Location 'C:\\My Files'\"")},
        "startingDirectory": ${q("C:\\work")},
      },
      { "name": "Old Shell", "commandline": "old.exe", "hidden": true },
      { "name": "Fake", "commandline": "fake.exe" },
      { "name": "Twice", "commandline": "first.exe" },
      { "name": "Twice", "commandline": "second.exe /k title" },
      { "name": "No Command" },
    ],
  },
}
`;

/** Only the schemes of a settings file, as a bare list. */
export const JSON_SCHEME_LIST = `[ ${jsonScheme("Lagoon")} ]`;

/** One scheme, as the whole file. */
export const JSON_ONE_SCHEME = jsonScheme("Lagoon");

/** A settings file with profiles and no schemes. */
export const JSON_PROFILES_ONLY = `{ "profiles": [ { "name": "Shell", "commandline": "sh" } ] }`;

/** JSON that is not valid (a value is missing). */
export const JSON_BROKEN = `{ "schemes": [ { "name": "x", "background": } ] }`;

/** Text that is none of the formats. */
export const NOT_A_SCHEME = "Dear diary, today the build was green.\nNothing else happened.\n";
