/** Tiny argv parser. Supports --flag, --key value, --key=value, and positional args.
 *  Boolean flags require explicit `--no-foo` to set false; otherwise `--foo` -> true. */
export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const body = a.slice(2);
      if (body.startsWith("no-")) {
        flags[body.slice(3)] = false;
        continue;
      }
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(a);
    }
  }

  return { positional, flags };
}

export function flagString(args: ParsedArgs, key: string, fallback?: string): string | undefined {
  const v = args.flags[key];
  if (typeof v === "string") return v;
  return fallback;
}

export function flagBool(args: ParsedArgs, key: string, fallback = false): boolean {
  const v = args.flags[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    return v !== "false" && v !== "0" && v !== "";
  }
  return fallback;
}
