import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockListPlans = vi.fn();
const mockCreatePlan = vi.fn();
const mockGetPlan = vi.fn();
const mockUpdatePlan = vi.fn();
const mockDeletePlan = vi.fn();

vi.mock("@/lib/plans", () => ({
  listPlans: (...args: unknown[]) => mockListPlans(...args),
  createPlan: (...args: unknown[]) => mockCreatePlan(...args),
  getPlan: (...args: unknown[]) => mockGetPlan(...args),
  updatePlan: (...args: unknown[]) => mockUpdatePlan(...args),
  deletePlan: (...args: unknown[]) => mockDeletePlan(...args),
}));

import { GET, POST } from "./route";
import { GET as GET_BY_ID, PUT, DELETE } from "./[id]/route";

function makeRequest(body: unknown, method = "POST"): NextRequest {
  return new NextRequest("http://localhost:3000/api/plans", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeIdParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/plans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the list of plans", async () => {
    const plans = [
      { id: "p_2000", title: "Plan B", updatedAt: "2025-03-15T10:00:00.000Z" },
      { id: "p_1000", title: "Plan A", updatedAt: "2025-01-01T10:00:00.000Z" },
    ];
    mockListPlans.mockResolvedValue(plans);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual(plans);
    expect(mockListPlans).toHaveBeenCalledOnce();
  });

  it("returns empty array when no plans exist", async () => {
    mockListPlans.mockResolvedValue([]);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });
});

describe("POST /api/plans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a plan with valid title", async () => {
    const createdPlan = {
      id: "p_1717232400000",
      title: "New Plan",
      createdAt: "2025-06-01T10:00:00.000Z",
      updatedAt: "2025-06-01T10:00:00.000Z",
      sourceAnalyses: [],
      angles: [],
      script: "",
      topics: [],
      notes: "",
    };
    mockCreatePlan.mockResolvedValue(createdPlan);

    const res = await POST(makeRequest({ title: "New Plan" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBe("p_1717232400000");
    expect(data.title).toBe("New Plan");
  });

  it("trims the title before creating", async () => {
    mockCreatePlan.mockResolvedValue({ id: "p_1", title: "Trimmed" });

    await POST(makeRequest({ title: "  Trimmed  " }));

    expect(mockCreatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Trimmed" })
    );
  });

  it("returns 400 when title is missing", async () => {
    const res = await POST(makeRequest({ sourceAnalyses: ["h_1"] }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("title");
  });

  it("returns 400 when title is not a string", async () => {
    const res = await POST(makeRequest({ title: 123 }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("title");
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest("http://localhost:3000/api/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid JSON");
  });

  it("passes optional fields to createPlan", async () => {
    mockCreatePlan.mockResolvedValue({ id: "p_1" });

    await POST(
      makeRequest({
        title: "Plan",
        sourceAnalyses: ["h_1", "h_2"],
        angles: [{ title: "A", hook: "H", format: "F" }],
        script: "script",
        topics: ["t1"],
        notes: "notes",
      })
    );

    expect(mockCreatePlan).toHaveBeenCalledWith({
      title: "Plan",
      sourceAnalyses: ["h_1", "h_2"],
      angles: [{ title: "A", hook: "H", format: "F" }],
      script: "script",
      topics: ["t1"],
      notes: "notes",
    });
  });

  it("defaults optional fields when not provided", async () => {
    mockCreatePlan.mockResolvedValue({ id: "p_1" });

    await POST(makeRequest({ title: "Minimal" }));

    expect(mockCreatePlan).toHaveBeenCalledWith({
      title: "Minimal",
      sourceAnalyses: [],
      angles: [],
      script: "",
      topics: [],
      notes: "",
    });
  });
});

describe("GET /api/plans/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the plan when it exists", async () => {
    const plan = { id: "p_1717232400000", title: "My Plan" };
    mockGetPlan.mockResolvedValue(plan);

    const req = new NextRequest("http://localhost:3000/api/plans/p_1717232400000");
    const res = await GET_BY_ID(req, makeIdParams("p_1717232400000"));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual(plan);
  });

  it("returns 404 when plan does not exist", async () => {
    mockGetPlan.mockResolvedValue(null);

    const req = new NextRequest("http://localhost:3000/api/plans/p_9999999999999");
    const res = await GET_BY_ID(req, makeIdParams("p_9999999999999"));

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("not found");
  });

  it("returns 400 for invalid ID format", async () => {
    const req = new NextRequest("http://localhost:3000/api/plans/invalid-id");
    const res = await GET_BY_ID(req, makeIdParams("invalid-id"));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid plan ID");
  });

  it("returns 400 for ID without p_ prefix", async () => {
    const req = new NextRequest("http://localhost:3000/api/plans/1717232400000");
    const res = await GET_BY_ID(req, makeIdParams("1717232400000"));

    expect(res.status).toBe(400);
  });

  it("returns 400 for ID with path traversal attempt", async () => {
    const req = new NextRequest("http://localhost:3000/api/plans/../etc/passwd");
    const res = await GET_BY_ID(req, makeIdParams("../etc/passwd"));

    expect(res.status).toBe(400);
  });
});

describe("PUT /api/plans/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates the plan and returns updated data", async () => {
    const updated = { id: "p_1717232400000", title: "Updated Title" };
    mockUpdatePlan.mockResolvedValue(updated);

    const req = new NextRequest("http://localhost:3000/api/plans/p_1717232400000", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated Title" }),
    });
    const res = await PUT(req, makeIdParams("p_1717232400000"));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.title).toBe("Updated Title");
    expect(mockUpdatePlan).toHaveBeenCalledWith("p_1717232400000", { title: "Updated Title" });
  });

  it("returns 404 when plan does not exist", async () => {
    mockUpdatePlan.mockResolvedValue(null);

    const req = new NextRequest("http://localhost:3000/api/plans/p_9999999999999", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New" }),
    });
    const res = await PUT(req, makeIdParams("p_9999999999999"));

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("not found");
  });

  it("returns 400 for invalid ID format", async () => {
    const req = new NextRequest("http://localhost:3000/api/plans/bad_id", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New" }),
    });
    const res = await PUT(req, makeIdParams("bad_id"));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid plan ID");
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest("http://localhost:3000/api/plans/p_1717232400000", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    const res = await PUT(req, makeIdParams("p_1717232400000"));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid JSON");
  });
});

describe("DELETE /api/plans/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the plan and returns success", async () => {
    mockDeletePlan.mockResolvedValue(true);

    const req = new NextRequest("http://localhost:3000/api/plans/p_1717232400000", {
      method: "DELETE",
    });
    const res = await DELETE(req, makeIdParams("p_1717232400000"));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deleted).toBe(true);
    expect(mockDeletePlan).toHaveBeenCalledWith("p_1717232400000");
  });

  it("returns 404 when plan does not exist", async () => {
    mockDeletePlan.mockResolvedValue(false);

    const req = new NextRequest("http://localhost:3000/api/plans/p_9999999999999", {
      method: "DELETE",
    });
    const res = await DELETE(req, makeIdParams("p_9999999999999"));

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("not found");
  });

  it("returns 400 for invalid ID format", async () => {
    const req = new NextRequest("http://localhost:3000/api/plans/not_valid", {
      method: "DELETE",
    });
    const res = await DELETE(req, makeIdParams("not_valid"));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid plan ID");
  });
});
