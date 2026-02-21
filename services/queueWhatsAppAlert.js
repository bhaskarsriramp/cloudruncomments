// services/queueWhatsAppAlert.js
// Writes an Agenda job document directly into agenda_jobs.
// The always-on backend Agenda worker picks it up and handles everything:
// MagicToken creation, WhatsApp send, wamid save, quota tracking, retries.
import mongoose from "mongoose";

const AGENDA_COLLECTION = "agenda_jobs";

export async function queueWhatsAppAlert({ conversationId, creatorId, participantId }) {
  const db = mongoose.connection.db;
  await db.collection(AGENDA_COLLECTION).insertOne({
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
  });
  console.log(`[CloudRun] 📋 WhatsApp alert queued for conversation ${conversationId}`);
}
