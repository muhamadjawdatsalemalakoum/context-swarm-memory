/** One-shot latency probe: time a single gemini-3.5-flash completeText call at
 *  increasing input sizes to find the usable per-chunk budget for the
 *  hierarchical Observation map step. The 10M build hung on 300K-token chunks;
 *  this measures where latency becomes prohibitive. No gold, no benchmark data. */
import { createProvider } from "../src/providers/index.js";
import { loadLocalEnv } from "../src/utils/loadEnv.js";

async function main(): Promise<void> {
  loadLocalEnv();
  // Fail fast instead of hanging 10 min on a stuck call.
  if (!process.env.CSM_GEMINI_TIMEOUT_MS) process.env.CSM_GEMINI_TIMEOUT_MS = "150000";
  if (!process.env.CSM_GEMINI_MAX_RETRIES) process.env.CSM_GEMINI_MAX_RETRIES = "1";
  const provider = createProvider();
  const model = process.env.CSM_AMB_MODEL ?? process.env.CSM_MODEL ?? "gemini-3.5-flash";
  console.log(`provider=${provider.name} model=${model} thinking=${process.env.CSM_GEMINI_THINKING ?? "(default)"}`);

  // "word " ≈ 1.25 est-tokens; pick repeat counts for target token sizes.
  const sizesK = (process.argv[2] ?? "50,150,300,600").split(",").map((s) => Number.parseInt(s, 10));
  for (const ktok of sizesK) {
    const repeats = Math.round((ktok * 1000) / 1.25);
    const filler = "topic alpha bravo charlie delta echo foxtrot golf ".repeat(Math.ceil(repeats / 8));
    const prompt =
      "Summarize the following conversation log into a numbered list of distinct topics.\n\n" +
      filler.slice(0, repeats * 5);
    const t0 = Date.now();
    try {
      const r = await provider.completeText({
        system: "You summarize faithfully and concisely.",
        prompt,
        model,
        maxOutputTokens: 1500,
        temperature: 0,
      });
      console.log(
        `~${ktok}K in: ${((Date.now() - t0) / 1000).toFixed(1)}s  inTok≈${r.usage.inputTokensEstimate}  outTok≈${r.usage.outputTokensEstimate}`,
      );
    } catch (err) {
      console.log(
        `~${ktok}K in: FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s :: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
