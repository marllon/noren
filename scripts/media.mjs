// `pnpm media` (NOR-F12-03): builds the web demo, runs the media script of the README
// (`e2e/media/readme.media.ts`, headless) and, when ffmpeg is on the PATH, makes an MP4 and a GIF
// from the webm. Without ffmpeg the webm stays and a note is printed; ffmpeg is never installed here.
import { spawnSync } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const media = resolve(root, "docs", "media");
const MAX_BYTES = 15 * 1024 * 1024;

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: true });
  if (result.status !== 0) {
    console.error(`media: "${command} ${args.join(" ")}" failed (${result.status})`);
    process.exit(result.status ?? 1);
  }
}

run("pnpm", ["demo:build"]);
run("pnpm", ["exec", "playwright", "test", "-c", "e2e/playwright.media.config.ts"]);

const webm = resolve(media, "noren-demo.webm");
if (!existsSync(webm)) {
  console.error("media: docs/media/noren-demo.webm was not written");
  process.exit(1);
}

const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", shell: true });
if (ffmpeg.status === 0) {
  run("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    `"${webm}"`,
    "-movflags",
    "+faststart",
    "-pix_fmt",
    "yuv420p",
    `"${resolve(media, "noren-demo.mp4")}"`,
  ]);
  run("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    `"${webm}"`,
    "-vf",
    '"fps=8,scale=800:-1:flags=lanczos"',
    `"${resolve(media, "noren-demo.gif")}"`,
  ]);
} else {
  console.warn("media: ffmpeg not found on the PATH; keeping the webm, no MP4 or GIF was made.");
}

const files = readdirSync(media);
const total = files.reduce((sum, name) => sum + statSync(resolve(media, name)).size, 0);
console.log(`media: ${files.length} files in docs/media, ${(total / 1024 / 1024).toFixed(2)} MiB`);
if (total > MAX_BYTES) {
  console.error("media: docs/media is over 15 MiB");
  process.exit(1);
}
