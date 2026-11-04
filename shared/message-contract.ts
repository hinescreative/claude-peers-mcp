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
  const isError = result.wake === "no-route" || result.wake === "failed";
  const hint = isError
    ? `\nNot delivered: no live peer has the id or nickname ${toId}, and the wake edge ${result.wake === "no-route" ? "has no route for it" : "did not answer"}. The message waits for a peer registered as ${result.to_id ?? toId} and is dropped if none claims it. Check list_peers.`
    : "";
  return {
    text: result.wake ? `${line}\nwake: ${result.wake}${hint}` : line,
    isError,
  };
}
