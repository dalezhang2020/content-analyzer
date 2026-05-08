import { NextRequest, NextResponse } from "next/server";
import { getHistoryById, deleteHistory } from "@/lib/history";

/** Validate history entry ID format: must match h_{digits} */
const ID_PATTERN = /^h_\d+$/;

/**
 * GET /api/history/[id]
 * Returns a single history entry by ID.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Sanitize and validate ID
  if (!id || typeof id !== "string" || !ID_PATTERN.test(id)) {
    return NextResponse.json(
      { error: "Invalid ID format. Must match pattern: h_{digits}" },
      { status: 400 }
    );
  }

  const entry = await getHistoryById(id);

  if (!entry) {
    return NextResponse.json({ error: "History entry not found" }, { status: 404 });
  }

  return NextResponse.json(entry);
}

/**
 * DELETE /api/history/[id]
 * Deletes a history entry by ID.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Sanitize and validate ID
  if (!id || typeof id !== "string" || !ID_PATTERN.test(id)) {
    return NextResponse.json(
      { error: "Invalid ID format. Must match pattern: h_{digits}" },
      { status: 400 }
    );
  }

  const deleted = await deleteHistory(id);

  if (!deleted) {
    return NextResponse.json({ error: "History entry not found" }, { status: 404 });
  }

  return NextResponse.json({ deleted: true });
}
