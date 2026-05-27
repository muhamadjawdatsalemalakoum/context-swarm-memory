import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

interface Args {
  ambDir: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ambDir = resolve(args.ambDir);
  const memoryDir = join(ambDir, "src", "memory_bench", "memory");
  const llmDir = join(ambDir, "src", "memory_bench", "llm");
  const initPath = join(memoryDir, "__init__.py");
  const geminiPath = join(llmDir, "gemini.py");
  const sourcePath = join(process.cwd(), "integrations", "amb", "csm_provider.py");
  const destPath = join(memoryDir, "csm.py");

  if (!existsSync(initPath)) {
    throw new Error(`AMB memory registry not found at ${initPath}`);
  }
  if (!existsSync(sourcePath)) {
    throw new Error(`CSM AMB provider source not found at ${sourcePath}`);
  }
  if (!existsSync(geminiPath)) {
    throw new Error(`AMB Gemini LLM source not found at ${geminiPath}`);
  }

  await mkdir(memoryDir, { recursive: true });
  await copyFile(sourcePath, destPath);

  let init = await readFile(initPath, "utf8");
  if (!init.includes("from .csm import CSMMemoryProvider")) {
    if (/from \.base import MemoryProvider\r?\n/.test(init)) {
      init = init.replace(
        /from \.base import MemoryProvider\r?\n/,
        "from .base import MemoryProvider\nfrom .csm import CSMMemoryProvider\n",
      );
    } else {
      init = `from .csm import CSMMemoryProvider\n${init}`;
    }
  }
  if (!init.includes('"csm": CSMMemoryProvider')) {
    if (/REGISTRY: dict\[str, type\[MemoryProvider\]\] = \{\r?\n/.test(init)) {
      init = init.replace(
        /REGISTRY: dict\[str, type\[MemoryProvider\]\] = \{\r?\n/,
        'REGISTRY: dict[str, type[MemoryProvider]] = {\n    "csm": CSMMemoryProvider,\n',
      );
    } else {
      throw new Error(`Could not find AMB REGISTRY literal in ${initPath}`);
    }
  }
  await writeFile(initPath, init, "utf8");

  let gemini = await readFile(geminiPath, "utf8");
  if (!gemini.includes("import os\n")) {
    gemini = gemini.replace("import logging\nimport time\n", "import logging\nimport os\nimport time\n");
  }
  if (!gemini.includes("OMB_GEMINI_TIMEOUT_MS")) {
    gemini = gemini.replace(
      "        self._client = genai.Client()\n",
      [
        '        timeout_ms = int(os.environ.get("OMB_GEMINI_TIMEOUT_MS", "600000"))',
        "        self._client = genai.Client(",
        "            http_options=types.HttpOptions(timeout=timeout_ms),",
        "        )",
        "",
      ].join("\n"),
    );
  }
  if (!gemini.includes('"timeout" in msg or "timed out" in msg')) {
    gemini = gemini.replace(
      '"503" in msg or "UNAVAILABLE" in msg):',
      '"503" in msg or "UNAVAILABLE" in msg or\n                        "timeout" in msg or "timed out" in msg or "ReadTimeout" in msg):',
    );
  }
  await writeFile(geminiPath, gemini, "utf8");

  process.stdout.write(`Patched AMB provider registry and Gemini timeout guard at ${ambDir}\n`);
}

function parseArgs(argv: string[]): Args {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    raw.set(key.slice(2), value);
    i++;
  }
  const ambDir = raw.get("amb-dir");
  if (!ambDir) {
    throw new Error("Usage: patch-amb-csm-provider --amb-dir <agent-memory-benchmark checkout>");
  }
  return { ambDir };
}

main().catch((err) => {
  process.stderr.write(
    `patch-amb-csm-provider failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});
