export type ImplementationRoute = "direct" | "delegated" | "sdd";
export type RouteAction = "select" | "propose";
export type RouteConfidence = "high" | "medium" | "low";

export interface ImplementationRouteFacts {
  alreadyUnderstood: boolean;
  filesToUnderstand?: number;
  filesToImplement?: number;
  mechanical?: boolean;
  needsResearch?: boolean;
  broadExploration?: boolean;
  independentWork?: boolean;
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

/**
 * Pick the smallest useful implementation route from explicit scope facts.
 * The result is guidance for the orchestrator; it never launches an agent or
 * treats a proposed SDD route as accepted without an explicit user decision.
 */
export function chooseImplementationRoute(
  facts: ImplementationRouteFacts,
): ImplementationRouteDecision {
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

  if (facts.durablePlanningUseful) {
    return {
      route: "sdd",
      action: "propose",
      confidence: "medium",
      requiresUserDecision: true,
      reason: facts.ambiguous
        ? "Durable planning artifacts would reduce uncertainty in the ambiguous work."
        : "Durable planning artifacts would materially reduce uncertainty.",
      next: "Offer SDD; do not create SDD artifacts until the user accepts it.",
    };
  }

  if (facts.ambiguous) {
    return {
      route: "direct",
      action: "select",
      confidence: "medium",
      requiresUserDecision: true,
      reason: "The material ambiguity requires a user response but does not by itself justify a separate workflow.",
      next: "Ask one focused question, wait for the answer (not SDD approval), then continue in the current session.",
    };
  }

  if (facts.broadExploration || facts.needsResearch || facts.independentWork) {
    const reasons: string[] = [];
    if (facts.broadExploration) reasons.push("genuinely broad exploration is needed");
    if (facts.needsResearch) reasons.push("broad multi-source research is needed");
    if (facts.independentWork) reasons.push("independent work justifies a separate context");

    return {
      route: "delegated",
      action: "select",
      confidence: reasons.length > 1 ? "high" : "medium",
      requiresUserDecision: false,
      reason: `Use a narrow delegated action because ${reasons.join("; ")}.`,
      next: "Delegate the independent investigation or work item, then inspect and integrate the result.",
    };
  }

  return {
    route: "direct",
    action: "select",
    confidence: facts.alreadyUnderstood ? "high" : "medium",
    requiresUserDecision: false,
    reason: facts.mechanical
      ? "The change is mechanical and can be handled directly even when it spans several files."
      : facts.alreadyUnderstood
        ? "The bounded change can be decided and verified in the current session."
        : "The unfamiliar work is bounded enough for focused inspection in the current session.",
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
