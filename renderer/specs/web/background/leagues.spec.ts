import { describe, expect, it } from "vitest";
import { pickSoftcoreChallengeLeague } from "@/web/background/Leagues";

describe("pickSoftcoreChallengeLeague", () => {
  it("picks temporary softcore challenge, not Standard/HC", () => {
    const list = [
      { id: "Runes of Aldur" },
      { id: "HC Runes of Aldur" },
      { id: "Standard" },
      { id: "Hardcore" },
    ];
    expect(pickSoftcoreChallengeLeague(list)).toBe("Runes of Aldur");
  });

  it("skips HC-prefixed challenge when that is first", () => {
    const list = [
      { id: "HC Runes of Aldur" },
      { id: "Runes of Aldur" },
      { id: "Standard" },
    ];
    expect(pickSoftcoreChallengeLeague(list)).toBe("Runes of Aldur");
  });
});
