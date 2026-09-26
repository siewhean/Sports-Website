import { NextResponse } from "next/server";
import { readCurrentIdentitySession } from "@/lib/identity-session.server";

const privateNoStoreHeaders = {
  "cache-control": "private, no-store",
  pragma: "no-cache",
} as const;

export async function GET() {
  const session = await readCurrentIdentitySession();

  if (session.status === "authenticated") {
    return NextResponse.json(
      {
        status: "authenticated",
        displayName: session.identity.displayName,
      },
      { headers: privateNoStoreHeaders },
    );
  }

  return NextResponse.json(
    {
      status: session.status,
      displayName: null,
    },
    { headers: privateNoStoreHeaders },
  );
}
