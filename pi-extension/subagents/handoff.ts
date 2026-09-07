export type HandoffStatus =
  | "complete"
  | "blocked"
  | "needs-decision"
  | "in-progress"
  | "failed"
  | "unknown";

export interface StructuredHandoff {
  status: HandoffStatus;
  summary: string;
  files: string[];
  verification: string[];
  risks: string[];
  next: string[];
  structured: boolean;
}

export const STRUCTURED_HANDOFF_INSTRUCTION = `
Use this concise format for your final response:

## Handoff
Status: complete | blocked | needs-decision
Summary:
- What you accomplished or why you are blocked.
Files:
- Files changed or inspected, or None.
Verification:
- Commands or checks actually run, or Not run.
Risks/Blockers:
- Remaining risks or blockers, or None.
Next:
- The next concrete action, or None.

Do not claim a check, file change, or result that you did not observe.`.trim();

const SECTION_NAMES = ["summary", "files", "verification", "risks", "next"] as const;
type SectionName = (typeof SECTION_NAMES)[number];

function emptySections(): Record<SectionName, string[]> {
  return { summary: [], files: [], verification: [], risks: [], next: [] };
}

function cleanItem(value: string): string {
  return value
    .trim()
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "")
    .trim();
}

function addValue(section: string[], value: string): void {
  const cleaned = cleanItem(value);
  if (cleaned) section.push(cleaned);
}

function normalizeStatus(value: string | undefined, fallback: HandoffStatus): HandoffStatus {
  const normalized = value?.trim().toLowerCase().replace(/[ _]+/g, "-");
  switch (normalized) {
    case "complete":
    case "completed":
    case "done":
    case "ready":
      return "complete";
    case "blocked":
      return "blocked";
    case "needs-decision":
    case "decision-needed":
      return "needs-decision";
    case "in-progress":
    case "working":
      return "in-progress";
    case "failed":
    case "failure":
    case "error":
      return "failed";
    default:
      return fallback;
  }
}

function sectionName(value: string): SectionName | null {
  const normalized = value.toLowerCase().replace(/[ _/\-]+/g, "");
  if (normalized === "summary") return "summary";
  if (normalized === "files" || normalized === "fileschanged") return "files";
  if (normalized === "verification" || normalized === "checks") return "verification";
  if (
    normalized === "risks" ||
    normalized === "risk" ||
    normalized === "blockers" ||
    normalized === "risksblockers" ||
    normalized === "risksandblockers"
  ) {
    return "risks";
  }
  if (normalized === "next" || normalized === "nextstep" || normalized === "nextrecommended") return "next";
  return null;
}

function fallbackHandoff(text: string, status: HandoffStatus): StructuredHandoff {
  return {
    status,
    summary: text.trim(),
    files: [],
    verification: [],
    risks: [],
    next: [],
    structured: false,
  };
}

/** Parse the stable Markdown handoff footer emitted by bundled and custom agents. */
export function parseStructuredHandoff(
  text: string,
  fallbackStatus: HandoffStatus = "unknown",
): StructuredHandoff {
  const lines = text.replace(/\r/g, "").split("\n");
  const handoffIndex = lines.findIndex((line) => /^\s*#{1,6}\s+handoff\s*$/i.test(line));
  if (handoffIndex < 0) return fallbackHandoff(text, fallbackStatus);

  const sections = emptySections();
  let statusValue: string | undefined;
  let current: SectionName | null = null;

  for (let i = handoffIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#{1,6}\s+/.test(line)) break;

    const statusMatch = line.match(/^\s*(?:[-*]\s+)?Status\s*:\s*(.*?)\s*$/i);
    if (statusMatch) {
      statusValue = statusMatch[1];
      current = null;
      continue;
    }

    const fieldMatch = line.match(
      /^\s*(?:[-*]\s+)?([^:]+?)\s*:\s*(.*?)\s*$/,
    );
    if (fieldMatch) {
      current = sectionName(fieldMatch[1].trim());
      if (current) addValue(sections[current], fieldMatch[2]);
      continue;
    }

    if (current && line.trim()) addValue(sections[current], line);
  }

  const summary = sections.summary.join(" ").trim();
  return {
    status: normalizeStatus(statusValue, fallbackStatus),
    summary,
    files: sections.files,
    verification: sections.verification,
    risks: sections.risks,
    next: sections.next,
    structured: true,
  };
}

export function createSubagentHandoff(
  text: string,
  outcome: { exitCode?: number; errorMessage?: string } = {},
): StructuredHandoff {
  const failed = Boolean(outcome.errorMessage) || (outcome.exitCode !== undefined && outcome.exitCode !== 0);
  const parsed = parseStructuredHandoff(text, failed ? "failed" : "unknown");
  if (!failed || parsed.status === "failed") return parsed;
  return { ...parsed, status: "failed" };
}
