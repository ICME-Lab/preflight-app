import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { CheckResult, MeResponse, PolicySummary, SseEvent } from "./types";

export const api = {
  hasApiKey: () => invoke<boolean>("has_api_key"),
  getApiKey: () => invoke<string | null>("get_api_key"),
  me: () => invoke<MeResponse>("get_me"),
  listPolicies: () => invoke<PolicySummary[] | { policies: PolicySummary[] }>("list_policies"),
  scenarios: (policyId: string) => invoke<unknown>("get_policy_scenarios", { policyId }),
  policyRules: (policyId: string) => invoke<unknown>("get_policy_rules", { policyId }),
  submitScenarioFeedback: (policyId: string, guardContent: string, approved: boolean, annotation?: string) =>
    invoke<unknown>("submit_scenario_feedback", { policyId, guardContent, approved, annotation }),
  checkRelevance: (policyId: string, action: string) =>
    invoke<{ should_check?: boolean }>("check_relevance", { policyId, action }),
  check: (policyId: string, action: string) =>
    invoke<CheckResult>("check_action", { policyId, action }),
  checkSse: (streamId: string, policyId: string, action: string) =>
    invoke<void>("check_action_sse", { streamId, policyId, action }),
  makeRulesSse: (streamId: string, policyText: string) =>
    invoke<void>("make_rules_sse", { streamId, policyText }),
  refinePolicySse: (streamId: string, policyId: string) =>
    invoke<void>("refine_policy_sse", { streamId, policyId }),
  proof: (proofId: string) => invoke<unknown>("get_proof", { proofId }),
  readActivity: (limit?: number) => invoke<unknown[]>("read_activity", { limit }),
  getHookStatus: () => invoke<{ installed: boolean; script_path: string | null; env_path: string | null; enabled: boolean; policy_id: string | null }>("get_hook_status"),
  setHookEnabled: (enabled: boolean) => invoke<void>("set_hook_enabled", { enabled }),
  setHookPolicy: (policyId: string) => invoke<void>("set_hook_policy", { policyId }),
  installClaudePreflight: () => invoke<number>("install_claude_preflight"),
  uninstallClaudePreflight: () => invoke<number>("uninstall_claude_preflight"),
  logout: () => invoke<number>("logout"),
  saveApiKey: (apiKey: string) => invoke<string>("save_api_key", { apiKey }),
  getHookEnvApiKey: () => invoke<string | null>("get_hook_env_api_key"),
  getHookScript: () => invoke<string | null>("get_hook_script"),
};

export function listenSse(
  channel: "preflight://check" | "preflight://make-rules" | "preflight://refine-policy",
  streamId: string,
  onEvent: (e: SseEvent) => void,
): Promise<UnlistenFn> {
  return listen<SseEvent>(channel, (e) => {
    if (e.payload.stream_id === streamId) onEvent(e.payload);
  });
}

export function newStreamId(): string {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
