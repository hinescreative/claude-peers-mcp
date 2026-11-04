import type { SendMessageRequest, SendMessageResponse } from "./types.ts";

export const messageContractVersion = 1;
export const messageToolProperties = {
  kind: { type: "string" as const, enum: ["request", "reply", "notification"], description: "request asks for work; reply answers an earlier request; notification needs no answer. Default request." },
  reply_to_id: { type: "integer" as const, minimum: 1, description: "Original message ID when replying. Sets kind=reply if omitted." },
  client_message_id: { type: "string" as const, minLength: 1, maxLength: 128, description: "Reuse the same ID when retrying this exact send; a changed message requires a new ID." },
};

// Keep transport metadata out of message text. Never silently discard it on an older broker.
export async function sendPeerMessage(
  call: (route: string, body: any) => Promise<any>,
  body: SendMessageRequest,
  args: Record<string, unknown> = {},
): Promise<SendMessageResponse> {
  const metadata = Object.fromEntries(["kind", "reply_to_id", "client_message_id"]
    .filter(key => args[key] !== undefined).map(key => [key, args[key]]));
  if (Object.keys(metadata).length) {
    const capabilities = await call("/capabilities", {});
    if (capabilities.message_contract !== messageContractVersion) throw new Error("Broker must support message contract v1 before sending metadata");
  }
  return call("/send-message", { ...body, ...metadata });
}

export function formatSendResult(
  toId: string,
  result: { message_id?: number; wake?: string; to_id?: string; resolved_from?: string },
): { text: string; isError: boolean } {
  const target = result.resolved_from && result.to_id ? `${result.to_id} (nickname ${result.resolved_from})` : toId;
  const line = `Message sent to peer ${target}. Message ID: ${result.message_id ?? "unavailable"}.`;
  if (!result.wake) return { text: line, isError: false };
  if (result.wake === "sent") return { text: `${line}\nwake: sent`, isError: false };
  // no-route, failed and unconfigured all mean the mail is stored but nobody is
  // reading it now. Say so, say why, and say when it would be read: lead-wake is
  // off by choice on this fleet (10-25), so "failed" is the usual state, not breakage.
  const why = result.wake === "no-route"
    ? "the wake edge has no route for it"
    : result.wake === "failed"
      ? "the wake edge did not answer"
      : "no wake edge is configured, so nothing starts the seat";
  const stored = result.to_id ?? toId;
  return {
    text: `${line}\nwake: ${result.wake}\nNot delivered now: ${toId} is not a live seat (missing, stale or poll-only), and ${why}. A seat registered as ${stored} reads it when it next runs; it is dropped after a day if none does. Check list_peers.`,
    isError: true,
  };
}
