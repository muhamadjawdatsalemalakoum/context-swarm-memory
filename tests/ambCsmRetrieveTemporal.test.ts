import { describe, expect, it } from "vitest";

import {
  buildCorpus,
  buildEvidenceCapsule,
  detectAmbQueryIntent,
  type AmbDocument,
} from "../scripts/amb-csm-retrieve.js";

describe("AMB CSM temporal evidence capsule", () => {
  it("derives an answer-ready date interval from source memories without gold answers", () => {
    const docs: AmbDocument[] = [
      {
        id: "beam-doc",
        user_id: "user-1",
        content: [
          "[Turn 1] User: I scheduled an unrelated meeting on March 26, 2024 and discussed generic API cleanup.",
          "[Turn 2] User: How can I improve my OpenWeather API rate limiter for the API key obtained on March 10, 2024?",
          "[Turn 3] Assistant: Use a token bucket and persist counters.",
          "[Turn 4] User: I completed the UI wireframe for my weather app on March 12, 2024 using Figma.",
        ].join("\n"),
      },
    ];
    const corpus = buildCorpus(docs);
    const query =
      "How many days passed between when I obtained my OpenWeather API key and when I completed the UI wireframe for my weather app?";
    const intent = detectAmbQueryIntent(query);

    const capsule = buildEvidenceCapsule({
      query,
      corpus,
      ids: [
        "beam-doc#turn-0",
        "beam-doc#turn-1",
        "beam-doc#turn-3",
      ],
      intent,
      userId: "user-1",
    });

    expect(capsule?.content).toContain("Temporal calculation:");
    expect(capsule?.content).toContain("March 10, 2024");
    expect(capsule?.content).toContain("March 12, 2024");
    expect(capsule?.content).toContain("2 days");
    expect(capsule?.content).toContain("beam-doc#turn-1");
    expect(capsule?.content).toContain("beam-doc#turn-3");
    expect(capsule?.content).not.toContain("LLM response should");
  });
});
