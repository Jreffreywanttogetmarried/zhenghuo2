import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const actionTypes = [
  "open_url", "click", "type", "select", "press_key", "scroll", "wait",
  "extract", "upload_file", "request_confirmation", "finish"
] as const;

const base = z.object({
  actionId: z.string().min(1).max(100),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  expectedPageVersion: z.string().min(1).max(128).optional(),
  timeoutMs: z.number().int().min(250).max(120_000).default(10_000),
  retryCount: z.number().int().min(0).max(3).default(0),
});

export const browserActionSchema = z.discriminatedUnion("type", [
  base.extend({ type: z.literal("open_url"), url: z.string().url().max(2_000), newTab: z.boolean().default(false) }),
  base.extend({ type: z.literal("click"), ref: z.string().min(1).max(128) }),
  base.extend({ type: z.literal("type"), ref: z.string().min(1).max(128), text: z.string().max(20_000), sensitive: z.boolean().default(false) }),
  base.extend({ type: z.literal("select"), ref: z.string().min(1).max(128), value: z.string().max(2_000) }),
  base.extend({ type: z.literal("press_key"), key: z.string().min(1).max(32) }),
  base.extend({ type: z.literal("scroll"), direction: z.enum(["up", "down"]), amount: z.number().int().min(1).max(2_000) }),
  base.extend({ type: z.literal("wait"), milliseconds: z.number().int().min(50).max(30_000) }),
  base.extend({ type: z.literal("extract"), refs: z.array(z.string().min(1).max(128)).min(1).max(100) }),
  base.extend({ type: z.literal("upload_file"), ref: z.string().min(1).max(128), fileId: z.string().uuid() }),
  base.extend({ type: z.literal("request_confirmation"), reason: z.string().min(1).max(1_000) }),
  base.extend({ type: z.literal("finish"), summary: z.string().min(1).max(5_000) }),
]);

export type BrowserAction = z.infer<typeof browserActionSchema>;

export const observationSchema = z.object({
  pageVersion: z.string().min(1).max(128),
  url: z.string().url().max(2_000),
  title: z.string().max(500),
  elements: z.array(z.object({
    ref: z.string().min(1).max(128), role: z.string().max(80), name: z.string().max(500),
    text: z.string().max(2_000).optional(), visible: z.boolean(), disabled: z.boolean(),
    inputType: z.string().max(40).optional(), value: z.string().max(500).optional(),
    hrefOrigin: z.string().url().max(500).optional(), hrefProtocol: z.enum(["http:", "https:", "unsafe"]).optional(),
  })).max(500),
  text: z.string().max(30_000),
}).strict();

export type PageObservation = z.infer<typeof observationSchema>;

export type ActionRisk = "low" | "medium" | "high" | "blocked";

const HIGH_RISK_WORDS = /submit|send|purchase|buy|pay|delete|remove|publish|login|sign\s?in|upload|download|transfer|confirm|checkout/i;
const SENSITIVE_WORDS = /password|passcode|otp|verification|credit|card|cvv|secret|token/i;

export function classifyRisk(action: BrowserAction, observation?: PageObservation): ActionRisk {
  if (action.type === "type" && (action.sensitive || SENSITIVE_WORDS.test(action.text))) return "blocked";
  if (action.type === "type" && observation) {
    const field = observation.elements.find((item) => item.ref === action.ref);
    if (field && (field.inputType === "password" || SENSITIVE_WORDS.test(field.name))) return "blocked";
  }
  if (action.type === "open_url") {
    try {
      const destination = new URL(action.url);
      if (!["http:", "https:"].includes(destination.protocol)) return "blocked";
      if (observation && new URL(observation.url).origin !== destination.origin) return "high";
    } catch { return "blocked"; }
  }
  if (action.type === "upload_file") return "high";
  if (action.type === "request_confirmation") return "high";
  if (action.type === "click" && observation) {
    const element = observation.elements.find((item) => item.ref === action.ref);
    if (element && HIGH_RISK_WORDS.test(`${element.name} ${element.text ?? ""}`)) return "high";
    if (element?.hrefProtocol === "unsafe") return "blocked";
    if (element?.hrefOrigin && element.hrefOrigin !== new URL(observation.url).origin) return "high";
  }
  if (action.type === "press_key" && action.key.toLowerCase() === "enter") return "high";
  return "low";
}

export function isActionAllowed(action: BrowserAction, observation?: PageObservation): { allowed: boolean; risk: ActionRisk; reason?: string } {
  const risk = classifyRisk(action, observation);
  if (risk === "blocked") return { allowed: false, risk, reason: "Sensitive or unsupported action requires manual handling." };
  if (risk === "high") return { allowed: false, risk, reason: "Explicit user confirmation is required before this action." };
  return { allowed: true, risk };
}

export const wireMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hello"), installationId: z.string().min(1), token: z.string().min(1) }),
  z.object({ kind: z.literal("observe"), runId: z.string().uuid(), observation: observationSchema }),
  z.object({ kind: z.literal("action_result"), runId: z.string().uuid(), actionId: z.string(), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional(), pageVersion: z.string().optional() }),
  z.object({ kind: z.literal("user_confirmation"), runId: z.string().uuid(), actionId: z.string(), approved: z.boolean() }),
  z.object({ kind: z.literal("stop"), runId: z.string().uuid() }),
]);

export type WireMessage = z.infer<typeof wireMessageSchema>;
