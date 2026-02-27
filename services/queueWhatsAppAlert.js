// services/queueWhatsAppAlert.js
// Writes an Agenda job document directly into agenda_jobs.
// The always-on backend Agenda worker picks it up and handles everything:
// MagicToken creation, WhatsApp send, wamid save, quota tracking, retries.
import mongoose from "mongoose";

const AGENDA_COLLECTION = "agenda_jobs";

export async function queueWhatsAppAlert({ conversationId, creatorId, participantId }) {
  const db = mongoose.connection.db;

  // Use upsert so that if a pending job already exists for this conversation,
  // a second rapid message does NOT create a duplicate job.
  // $setOnInsert only writes when the document is newly created (no match found).
  const result = await db.collection(AGENDA_COLLECTION).updateOne(
    {
      name: "send-whatsapp-alert",
      "data.conversationId": conversationId.toString(),
      lockedAt: null, // only match jobs that haven't been picked up yet
    },
    {
      $setOnInsert: {
        name: "send-whatsapp-alert",
        data: {
          conversationId: conversationId.toString(),
          creatorId: creatorId.toString(),
          participantId: participantId.toString(),
          attempt: 0,
        },
        type: "normal",
        priority: 0,
        nextRunAt: new Date(),
        lockedAt: null,
        lastModifiedBy: null,
      },
    },
    { upsert: true }
  );

  if (result.upsertedCount > 0) {
    console.log(`[CloudRun] 📋 WhatsApp alert queued for conversation ${conversationId}`);
  } else {
    console.log(`[CloudRun] ⏭️ WhatsApp alert already pending for conversation ${conversationId}, skipping duplicate`);
  }
}
