import { z } from "zod";

// Evaluated before any schema is built (`index.ts` imports it first). By default zod compiles a
// faster parser for each object schema with `new Function`, after probing whether the page allows
// it; under the strict Content Security Policy of the app (no `unsafe-eval`) that probe is refused
// and reported as a policy violation on every start, even though zod catches it. Turning the
// compiler off skips the probe and keeps every schema working through the plain parser, which is
// plenty for the small files (config, themes, state) this package reads.
z.config({ jitless: true });
