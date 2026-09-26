import { NextResponse } from "next/server";
import { readCurrentIdentitySession } from "@/lib/identity-session.server";
import { identityStatusResponseHeaders, identityStatusValues } from "@/lib/identity-status";

export async function GET() {
  const session = await readCurrentIdentitySession();

  if (session.status === identityStatusValues.authenticated) {
    return NextResponse.json(
      {
        status: identityStatusValues.authenticated,
        displayName: session.identity.displayName,
      },
      { headers: identityStatusResponseHeaders },
    );
  }

  return NextResponse.json(
    {
      status: session.status,
      displayName: null,
    },
    { headers: identityStatusResponseHeaders },
  );
}
