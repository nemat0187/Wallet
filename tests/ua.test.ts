import { describe, expect, it } from "vitest";
import { describeAgent } from "../worker/lib/ua";

describe("describeAgent", () => {
  it("names browser and system", () => {
    expect(describeAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36")).toBe("Chrome on Android");
    expect(describeAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
    expect(describeAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0")).toBe("Edge on Windows");
    expect(describeAgent("Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0")).toBe("Firefox on Linux");
  });
  it("copes with nothing", () => {
    expect(describeAgent(null)).toBe("Unknown device");
    expect(describeAgent("")).toBe("Unknown device");
  });
});
