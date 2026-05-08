import { NextRequest, NextResponse } from "next/server";
import { getPlan, updatePlan, deletePlan } from "@/lib/plans";

const ID_PATTERN = /^p_\d+$/;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!ID_PATTERN.test(id)) {
    return NextResponse.json({ error: "Invalid plan ID" }, { status: 400 });
  }
  const plan = await getPlan(id);
  if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  return NextResponse.json(plan);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!ID_PATTERN.test(id)) {
    return NextResponse.json({ error: "Invalid plan ID" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updated = await updatePlan(id, body);
  if (!updated) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  return NextResponse.json(updated);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!ID_PATTERN.test(id)) {
    return NextResponse.json({ error: "Invalid plan ID" }, { status: 400 });
  }
  const deleted = await deletePlan(id);
  if (!deleted) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
