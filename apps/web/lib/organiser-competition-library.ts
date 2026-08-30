export type OrganiserCompetitionPhase = "draft" | "upcoming" | "live" | "completed";

export type OrganiserCompetitionLibraryItem = Readonly<{
  id: string;
  organisationId: string;
  organisationName: string;
  membershipRole: "owner" | "organiser";
  name: string;
  slug: string;
  sportCode: string;
  status: string;
  startsOn: string;
  endsOn: string;
  timezone: string;
  updatedAt: string;
  published: boolean;
}>;

export const organiserCompetitionLibraryCopy = {
  title: "My competitions",
  subtitle: "Return to drafts, prepare upcoming events, run live competitions, or review completed ones.",
  openLibrary: "View my competitions",
  createCompetition: "Create competition",
  emptyTitle: "No competitions yet",
  emptyBody: "Create your first competition and it will appear here automatically on every device you sign in to.",
  draftTitle: "Drafts",
  draftDescription: "Created but not yet published. Continue setup from where you left off.",
  upcomingTitle: "Upcoming",
  upcomingDescription: "Published or active competitions that have not started yet.",
  liveTitle: "Live",
  liveDescription: "Competitions currently inside their scheduled event dates.",
  completedTitle: "Completed",
  completedDescription: "Finished or archived competitions retained for results, audit, and reference.",
  continueSetup: "Continue setup",
  manageCompetition: "Manage competition",
  reviewCompetition: "Review competition",
  viewPublicPage: "View public page",
  privateDraft: "Private draft",
  published: "Published",
  ownerRole: "Owner",
  organiserRole: "Organiser",
  updatedLabel: "Updated",
  dateLabel: "Dates",
  organisationLabel: "Organisation",
  sportLabel: "Sport",
  loadError: "Your competitions could not be loaded. No changes were made.",
} as const;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function parseOrganiserCompetitionLibrary(value: unknown): OrganiserCompetitionLibraryItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: OrganiserCompetitionLibraryItem[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        "id",
        "organisation_id",
        "organisation_name",
        "membership_role",
        "name",
        "slug",
        "sport_code",
        "status",
        "starts_on",
        "ends_on",
        "timezone",
        "updated_at",
        "published",
      ]) ||
      typeof entry.id !== "string" ||
      !uuidPattern.test(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.organisation_id !== "string" ||
      !uuidPattern.test(entry.organisation_id) ||
      typeof entry.organisation_name !== "string" ||
      entry.organisation_name.trim().length === 0 ||
      (entry.membership_role !== "owner" && entry.membership_role !== "organiser") ||
      typeof entry.name !== "string" ||
      entry.name.trim().length === 0 ||
      typeof entry.slug !== "string" ||
      entry.slug.trim().length === 0 ||
      typeof entry.sport_code !== "string" ||
      entry.sport_code.trim().length === 0 ||
      typeof entry.status !== "string" ||
      entry.status.trim().length === 0 ||
      typeof entry.starts_on !== "string" ||
      !datePattern.test(entry.starts_on) ||
      typeof entry.ends_on !== "string" ||
      !datePattern.test(entry.ends_on) ||
      typeof entry.timezone !== "string" ||
      entry.timezone.trim().length === 0 ||
      typeof entry.updated_at !== "string" ||
      !Number.isFinite(new Date(entry.updated_at).getTime()) ||
      typeof entry.published !== "boolean"
    ) {
      return null;
    }
    ids.add(entry.id);
    items.push({
      id: entry.id,
      organisationId: entry.organisation_id,
      organisationName: entry.organisation_name,
      membershipRole: entry.membership_role,
      name: entry.name,
      slug: entry.slug,
      sportCode: entry.sport_code,
      status: entry.status,
      startsOn: entry.starts_on,
      endsOn: entry.ends_on,
      timezone: entry.timezone,
      updatedAt: entry.updated_at,
      published: entry.published,
    });
  }
  return items;
}

function calendarDateInTimeZone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : now.toISOString().slice(0, 10);
}

export function organiserCompetitionPhase(
  item: OrganiserCompetitionLibraryItem,
  now: Date = new Date(),
): OrganiserCompetitionPhase {
  if (item.status === "draft") return "draft";
  if (item.status === "completed" || item.status === "archived") return "completed";
  const today = calendarDateInTimeZone(now, item.timezone);
  if (item.endsOn < today) return "completed";
  if (item.startsOn > today) return "upcoming";
  return "live";
}

export function organiserCompetitionGroups(items: readonly OrganiserCompetitionLibraryItem[]) {
  const phases: OrganiserCompetitionPhase[] = ["draft", "upcoming", "live", "completed"];
  return phases.map((phase) => ({
    phase,
    items: items.filter((item) => organiserCompetitionPhase(item) === phase),
  }));
}

export function organiserCompetitionPhaseCopy(phase: OrganiserCompetitionPhase) {
  switch (phase) {
    case "draft":
      return {
        title: organiserCompetitionLibraryCopy.draftTitle,
        description: organiserCompetitionLibraryCopy.draftDescription,
      };
    case "upcoming":
      return {
        title: organiserCompetitionLibraryCopy.upcomingTitle,
        description: organiserCompetitionLibraryCopy.upcomingDescription,
      };
    case "live":
      return {
        title: organiserCompetitionLibraryCopy.liveTitle,
        description: organiserCompetitionLibraryCopy.liveDescription,
      };
    case "completed":
      return {
        title: organiserCompetitionLibraryCopy.completedTitle,
        description: organiserCompetitionLibraryCopy.completedDescription,
      };
  }
}

export function organiserCompetitionPrimaryAction(item: OrganiserCompetitionLibraryItem) {
  const phase = organiserCompetitionPhase(item);
  if (phase === "draft") {
    return {
      href: `/organiser/competitions/${encodeURIComponent(item.id)}/setup`,
      label: organiserCompetitionLibraryCopy.continueSetup,
    };
  }
  if (phase === "completed") {
    return {
      href: `/organiser/competitions/${encodeURIComponent(item.id)}`,
      label: organiserCompetitionLibraryCopy.reviewCompetition,
    };
  }
  return {
    href: `/organiser/competitions/${encodeURIComponent(item.id)}`,
    label: organiserCompetitionLibraryCopy.manageCompetition,
  };
}

export function organiserCompetitionSportName(sportCode: string): string {
  return sportCode
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function organiserCompetitionDateRange(item: OrganiserCompetitionLibraryItem): string {
  const formatter = new Intl.DateTimeFormat("en-SG", { day: "numeric", month: "short", year: "numeric" });
  const start = new Date(`${item.startsOn}T00:00:00Z`);
  const end = new Date(`${item.endsOn}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return `${item.startsOn} – ${item.endsOn}`;
  }
  return item.startsOn === item.endsOn
    ? formatter.format(start)
    : `${formatter.format(start)} – ${formatter.format(end)}`;
}

export function organiserCompetitionUpdatedLabel(item: OrganiserCompetitionLibraryItem): string {
  const formatter = new Intl.DateTimeFormat("en-SG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${organiserCompetitionLibraryCopy.updatedLabel} ${formatter.format(new Date(item.updatedAt))}`;
}

export function organiserCompetitionRoleLabel(item: OrganiserCompetitionLibraryItem): string {
  return item.membershipRole === "owner"
    ? organiserCompetitionLibraryCopy.ownerRole
    : organiserCompetitionLibraryCopy.organiserRole;
}
