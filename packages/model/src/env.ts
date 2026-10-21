/**
 * True when every name is a usable environment variable name and no value holds a NUL. Kept apart
 * from the reducer so the file of a space (`space-file.ts`) can use it without a cycle.
 */
export function validEnv(env: Record<string, string>): boolean {
  return Object.entries(env).every(
    ([name, value]) =>
      name !== "" && !/[=\s]/.test(name) && !name.includes("\u0000") && !value.includes("\u0000"),
  );
}
