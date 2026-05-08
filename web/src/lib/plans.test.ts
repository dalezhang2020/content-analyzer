import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:fs/promises
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn();
const mockUnlink = vi.fn();
const mockReaddir = vi.fn();

vi.mock("node:fs", () => {
  const fsMock = {
    promises: {
      mkdir: (...args: unknown[]) => mockMkdir(...args),
      writeFile: (...args: unknown[]) => mockWriteFile(...args),
      readFile: (...args: unknown[]) => mockReadFile(...args),
      unlink: (...args: unknown[]) => mockUnlink(...args),
      readdir: (...args: unknown[]) => mockReaddir(...args),
    },
  };
  return { ...fsMock, default: fsMock };
});

import { createPlan, getPlan, updatePlan, deletePlan, listPlans } from "./plans";

describe("plans utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("createPlan", () => {
    it("generates an ID with p_ prefix and timestamp", async () => {
      const plan = await createPlan({
        title: "Test Plan",
        sourceAnalyses: [],
        angles: [],
        script: "",
        topics: [],
        notes: "",
      });

      expect(plan.id).toBe(`p_${Date.now()}`);
    });

    it("sets createdAt and updatedAt to current timestamp", async () => {
      const plan = await createPlan({
        title: "Test Plan",
        sourceAnalyses: [],
        angles: [],
        script: "",
        topics: [],
        notes: "",
      });

      expect(plan.createdAt).toBe("2025-06-01T10:00:00.000Z");
      expect(plan.updatedAt).toBe("2025-06-01T10:00:00.000Z");
    });

    it("writes JSON file to the correct path", async () => {
      await createPlan({
        title: "My Plan",
        sourceAnalyses: ["h_123"],
        angles: [{ title: "Angle 1", hook: "Hook text", format: "video" }],
        script: "HOOK:\nTest",
        topics: ["AI"],
        notes: "Some notes",
      });

      expect(mockWriteFile).toHaveBeenCalledOnce();
      const [filePath, content] = mockWriteFile.mock.calls[0];
      expect(filePath).toContain(`p_${Date.now()}.json`);
      expect(filePath).toContain("data/plans");

      const parsed = JSON.parse(content);
      expect(parsed.title).toBe("My Plan");
      expect(parsed.sourceAnalyses).toEqual(["h_123"]);
      expect(parsed.angles).toHaveLength(1);
    });

    it("ensures data directory exists before writing", async () => {
      await createPlan({
        title: "Test",
        sourceAnalyses: [],
        angles: [],
        script: "",
        topics: [],
        notes: "",
      });

      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining("data/plans"),
        { recursive: true }
      );
    });

    it("returns the full plan object with all fields", async () => {
      const plan = await createPlan({
        title: "Full Plan",
        sourceAnalyses: ["h_1", "h_2"],
        angles: [{ title: "A", hook: "H", format: "F" }],
        script: "script content",
        topics: ["topic1", "topic2"],
        notes: "my notes",
      });

      expect(plan.title).toBe("Full Plan");
      expect(plan.sourceAnalyses).toEqual(["h_1", "h_2"]);
      expect(plan.angles).toEqual([{ title: "A", hook: "H", format: "F" }]);
      expect(plan.script).toBe("script content");
      expect(plan.topics).toEqual(["topic1", "topic2"]);
      expect(plan.notes).toBe("my notes");
    });
  });

  describe("getPlan", () => {
    it("returns the plan when file exists", async () => {
      const planData = {
        id: "p_1717232400000",
        title: "Existing Plan",
        createdAt: "2025-06-01T10:00:00.000Z",
        updatedAt: "2025-06-01T10:00:00.000Z",
        sourceAnalyses: [],
        angles: [],
        script: "",
        topics: [],
        notes: "",
      };
      mockReadFile.mockResolvedValue(JSON.stringify(planData));

      const result = await getPlan("p_1717232400000");

      expect(result).toEqual(planData);
      expect(mockReadFile).toHaveBeenCalledWith(
        expect.stringContaining("p_1717232400000.json"),
        "utf-8"
      );
    });

    it("returns null when file does not exist", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT: no such file"));

      const result = await getPlan("p_9999999999999");

      expect(result).toBeNull();
    });

    it("returns null for malformed JSON", async () => {
      mockReadFile.mockResolvedValue("not valid json {{{");

      const result = await getPlan("p_1717232400000");

      expect(result).toBeNull();
    });
  });

  describe("updatePlan", () => {
    const existingPlan = {
      id: "p_1717232400000",
      title: "Original Title",
      createdAt: "2025-05-01T10:00:00.000Z",
      updatedAt: "2025-05-01T10:00:00.000Z",
      sourceAnalyses: ["h_1"],
      angles: [],
      script: "old script",
      topics: ["old"],
      notes: "old notes",
    };

    it("merges updates and updates the timestamp", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify(existingPlan));

      const result = await updatePlan("p_1717232400000", { title: "New Title" });

      expect(result).not.toBeNull();
      expect(result!.title).toBe("New Title");
      expect(result!.updatedAt).toBe("2025-06-01T10:00:00.000Z");
      // Other fields remain unchanged
      expect(result!.script).toBe("old script");
      expect(result!.createdAt).toBe("2025-05-01T10:00:00.000Z");
    });

    it("writes the updated plan to disk", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify(existingPlan));

      await updatePlan("p_1717232400000", { notes: "updated notes" });

      expect(mockWriteFile).toHaveBeenCalledOnce();
      const [filePath, content] = mockWriteFile.mock.calls[0];
      expect(filePath).toContain("p_1717232400000.json");
      const parsed = JSON.parse(content);
      expect(parsed.notes).toBe("updated notes");
    });

    it("returns null when plan does not exist", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT: no such file"));

      const result = await updatePlan("p_9999999999999", { title: "New" });

      expect(result).toBeNull();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("can update multiple fields at once", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify(existingPlan));

      const result = await updatePlan("p_1717232400000", {
        title: "Updated",
        script: "new script",
        topics: ["new1", "new2"],
      });

      expect(result!.title).toBe("Updated");
      expect(result!.script).toBe("new script");
      expect(result!.topics).toEqual(["new1", "new2"]);
    });
  });

  describe("deletePlan", () => {
    it("returns true when file is successfully deleted", async () => {
      mockUnlink.mockResolvedValue(undefined);

      const result = await deletePlan("p_1717232400000");

      expect(result).toBe(true);
      expect(mockUnlink).toHaveBeenCalledWith(
        expect.stringContaining("p_1717232400000.json")
      );
    });

    it("returns false when file does not exist", async () => {
      mockUnlink.mockRejectedValue(new Error("ENOENT: no such file"));

      const result = await deletePlan("p_9999999999999");

      expect(result).toBe(false);
    });
  });

  describe("listPlans", () => {
    const plans = [
      {
        id: "p_1000",
        title: "Plan A",
        createdAt: "2025-01-01T10:00:00.000Z",
        updatedAt: "2025-01-01T10:00:00.000Z",
        sourceAnalyses: [],
        angles: [],
        script: "",
        topics: [],
        notes: "",
      },
      {
        id: "p_2000",
        title: "Plan B",
        createdAt: "2025-03-15T10:00:00.000Z",
        updatedAt: "2025-03-15T10:00:00.000Z",
        sourceAnalyses: [],
        angles: [],
        script: "",
        topics: [],
        notes: "",
      },
      {
        id: "p_3000",
        title: "Plan C",
        createdAt: "2025-06-01T10:00:00.000Z",
        updatedAt: "2025-06-01T10:00:00.000Z",
        sourceAnalyses: [],
        angles: [],
        script: "",
        topics: [],
        notes: "",
      },
    ];

    beforeEach(() => {
      mockReaddir.mockResolvedValue(["p_1000.json", "p_2000.json", "p_3000.json"]);
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes("p_1000")) return Promise.resolve(JSON.stringify(plans[0]));
        if (filePath.includes("p_2000")) return Promise.resolve(JSON.stringify(plans[1]));
        if (filePath.includes("p_3000")) return Promise.resolve(JSON.stringify(plans[2]));
        return Promise.reject(new Error("ENOENT"));
      });
    });

    it("returns all plans sorted by updatedAt descending", async () => {
      const result = await listPlans();

      expect(result).toHaveLength(3);
      expect(result[0].id).toBe("p_3000");
      expect(result[1].id).toBe("p_2000");
      expect(result[2].id).toBe("p_1000");
    });

    it("returns empty array when directory read fails", async () => {
      mockReaddir.mockRejectedValue(new Error("ENOENT"));

      const result = await listPlans();

      expect(result).toHaveLength(0);
    });

    it("skips non-JSON files", async () => {
      mockReaddir.mockResolvedValue(["p_1000.json", "readme.txt", ".DS_Store"]);
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes("p_1000")) return Promise.resolve(JSON.stringify(plans[0]));
        return Promise.reject(new Error("ENOENT"));
      });

      const result = await listPlans();

      expect(result).toHaveLength(1);
    });

    it("skips malformed JSON files gracefully", async () => {
      mockReaddir.mockResolvedValue(["p_1000.json", "p_bad.json"]);
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes("p_1000")) return Promise.resolve(JSON.stringify(plans[0]));
        if (filePath.includes("p_bad")) return Promise.resolve("not valid json");
        return Promise.reject(new Error("ENOENT"));
      });

      const result = await listPlans();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("p_1000");
    });

    it("ensures data directory exists", async () => {
      await listPlans();

      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining("data/plans"),
        { recursive: true }
      );
    });
  });
});
