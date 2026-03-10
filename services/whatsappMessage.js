// whatsappMessage.js
import axios from "axios";

async function sendWhatsAppAlert(creatorPhone, leadName, leadMessage, urlToken) {

  const url = `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`;

  const data = {
    messaging_product: "whatsapp",
    to: creatorPhone,
    type: "template",
    template: {
      name: "message_new",
      language: { 
        code: "en"
      },
      components: [
        {
          type: "body",
          parameters: [
            { 
              type: "text", 
              parameter_name: "name",
              text: leadName 
            },
            { 
              type: "text", 
              parameter_name: "message",
              text: leadMessage
            }
          ]
        },
        // Component 2: The Dynamic Button (The Token)
        {
          type: "button",
          sub_type: "url",
          index: 0, // Targets the first button in your template
          parameters: [
            {
              type: "text",
              text: urlToken // Appends this to your Base URL (e.g. ?token=urlToken)
            }
          ]
        }
      ]
    }
  };

  try {
    const response = await axios.post(url, data, {
      headers: { 
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log("✅ Alert sent successfully:", response.data);
    return response.data;
  } catch (error) {
    // Enhanced error logging to see exactly why Meta might reject it
    console.error("❌ Error sending WhatsApp:", JSON.stringify(error.response?.data || error.message, null, 2));
    throw error; // Re-throw if you want the caller to handle the failure
  }
}

// Subscribe your app to receive webhook events for a WhatsApp Business Account (WABA).
// Call this once per WABA (e.g. during onboarding or first-time setup).
// Requires: WABA_ID and WHATSAPP_SYSTEM_TOKEN env vars.
// Equivalent to subscribePageToInstagramWebhooks() but for WhatsApp.
async function subscribeWABAToWebhooks() {
  const wabaId      = process.env.WABA_ID;
  const systemToken = process.env.WHATSAPP_SYSTEM_TOKEN;

  if (!wabaId)      throw new Error("WABA_ID env var is required");
  if (!systemToken) throw new Error("WHATSAPP_SYSTEM_TOKEN env var is required");

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v24.0/${encodeURIComponent(wabaId)}/subscribed_apps`,
      null,
      {
        headers: { Authorization: `Bearer ${systemToken}` },
        timeout: 15000,
      }
    );

    const success = response?.data?.success;
    console.log("subscribeWABAToWebhooks raw response:", response?.data);

    if (success) {
      console.log(`✅ WABA ${wabaId} subscribed to webhooks`);
    } else {
      console.warn("⚠️ WABA subscription response unclear:", response?.data);
    }

    return { success, raw: response?.data };
  } catch (error) {
    console.error(
      "❌ subscribeWABAToWebhooks failed:",
      JSON.stringify(error.response?.data || error.message, null, 2)
    );
    return { success: false, error: error.message };
  }
}

export { sendWhatsAppAlert, subscribeWABAToWebhooks };