import * as Cloudflare from "alchemy/Cloudflare";

export const RelayApnsDeliveryDeadLetterQueue = Cloudflare.Queues.Queue(
  "RelayApnsDeliveryDeadLetterQueue",
);

export const RelayApnsDeliveryQueue = Cloudflare.Queues.Queue("RelayApnsDeliveryQueue");

export const RelayFcmDeliveryQueue = Cloudflare.Queues.Queue("RelayFcmDeliveryQueue");
export const RelayFcmDeliveryDeadLetterQueue = Cloudflare.Queues.Queue(
  "RelayFcmDeliveryDeadLetterQueue",
);

/** Photos and documents sent in chat mode. */
export const RelayChatAttachmentsBucket = Cloudflare.R2.Bucket("RelayChatAttachments");
