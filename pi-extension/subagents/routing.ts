export type ImplementationRoute = "direct" | "delegated" | "sdd";
export type RouteAction = "select" | "propose";
export type RouteConfidence = "high" | "medium" | "low";

export interface ImplementationRouteFacts {
  alreadyUnderstood: boolean;
  filesToUnderstand?: number;
  filesToImplement?: number;
  mechanical?: boolean;
  needsResearch?: boolean;
  ambiguous?: boolean;
  durablePlanningUseful?: boolean;
  sddRequested?: boolean;
}

export interface ImplementationRouteDecision {
  route: ImplementationRoute;
  action: RouteAction;
  confidence: RouteConfidence;
  requiresUserDecision: boolean;
  reason: string;
  next: string;
}

function validCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Pick the smallest useful implementation route from explicit scope facts.
 * The result is guidance for the orchestrator; it never launches an agent or
 * treats a proposed SDD route as accepted without an explicit user decision.
 */
export function chooseImplementationRoute(
  facts: ImplementationRouteFacts,
): ImplementationRouteDecision {
  const filesToUnderstand = validCount(facts.filesToUnderstand);
  const filesToImplement = validCount(facts.filesToImplement);

  if (facts.sddRequested) {
    return {
      route: "sdd",
      action: "select",
      confidence: "high",
      requiresUserDecision: false,
      reason: "The user explicitly requested a structured SDD workflow.",
      next: "Start the SDD preflight and planning phases before implementation.",
    };
  }

  if (facts.ambiguous || facts.durablePlanningUseful) {
    return {
      route: "sdd",
      action: "propose",
      confidence: "medium",
      requiresUserDecision: true,
      reason:
        facts.ambiguous && facts.durablePlanningUseful
          ? "The work is ambiguous and durable planning would reduce uncertainty."
          : facts.ambiguous
            ? "The work has substantial unresolved ambiguity."
            : "Durable planning artifacts would materially reduce uncertainty.",
      next: "Offer SDD; do not create SDD artifacts until the user accepts it.",
    };
  }

  const broadUnderstanding = filesToUnderstand !== undefined && filesToUnderstand >= 4;
  const broadImplementation = filesToImplement !== undefined && filesToImplement >= 2;
  if (facts.needsResearch || broadUnderstanding || broadImplementation || !facts.alreadyUnderstood) {
    const reasons: string[] = [];
    if (facts.needsResearch) reasons.push("research is needed");
    if (broadUnderstanding) reasons.push("understanding spans four or more files");
    if (broadImplementation) reasons.push("implementation spans two or more non-trivial files");
    if (!facts.alreadyUnderstood && reasons.length === 0) reasons.push("the work is not yet understood");

    return {
      route: "delegated",
      action: "select",
      confidence: reasons.length > 1 ? "high" : "medium",
      requiresUserDecision: false,
      reason: `Use a narrow delegated action because ${reasons.join("; ")}.`,
      next: "Delegate read-only exploration or one writer, then inspect and integrate the result.",
    };
  }

  return {
    route: "direct",
    action: "select",
    confidence: "high",
    requiresUserDecision: false,
    reason: facts.mechanical
      ? "The already-understood change is mechanical and bounded."
      : "The already-understood change can be decided and verified within a small scope.",
    next: "Keep the action in the current session and run the applicable verification.",
  };
}

export function formatImplementationRouteDecision(
  task: string,
  decision: ImplementationRouteDecision,
): string {
  const subject = task.trim() || "(no task description)";
  const action = decision.action === "propose" ? "proposed; explicit acceptance required" : "selected";
  return [
    `Implementation route for: ${subject}`,
    `Route: ${decision.route}`,
    `Decision: ${action}`,
    `Confidence: ${decision.confidence}`,
    `Reason: ${decision.reason}`,
    `Next: ${decision.next}`,
  ].join("\n");
}
