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

export { sendWhatsAppAlert };