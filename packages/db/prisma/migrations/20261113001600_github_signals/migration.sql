ALTER TABLE "Signal" ADD COLUMN "githubDeliveryId" TEXT REFERENCES "GithubEvent"("deliveryId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Signal" DROP CONSTRAINT "Signal_single_sender";
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_single_sender" CHECK (num_nonnulls("senderId", "senderAgentId", "githubDeliveryId") = 1);
CREATE UNIQUE INDEX "Signal_githubDeliveryId_recipientId_key" ON "Signal"("githubDeliveryId", "recipientId");
