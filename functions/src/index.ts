import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import admin from "firebase-admin";
import Stripe from "stripe";
import OpenAI from "openai";
import { ImageAnnotatorClient } from "@google-cloud/vision";

if (!admin.apps.length) {
  admin.initializeApp();
}

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");


// ======================================================
// ===================== SCAN LABEL ======================
// ======================================================

export const scanLabel = onCall(
{
  region: "us-central1",
  secrets: [OPENAI_API_KEY],
  memory: "512MiB",
  timeoutSeconds: 120,
},
async (request) => {

  const { imageBase64 } = request.data;

  if (!imageBase64) {
    throw new HttpsError("invalid-argument", "imageBase64 não fornecido");
  }

  const vision = new ImageAnnotatorClient();

  const [result] = await vision.textDetection({
    image: { content: imageBase64 },
  });

  const extractedText = result.textAnnotations?.[0]?.description || "";

  if (!extractedText) {
    throw new HttpsError("internal", "Nenhum texto detectado");
  }

  const cleanedText = extractedText
    .replace(/QR[\s\S]*$/gi, "")
    .replace(/DATA\s*ENTREGA.*$/gim, "")
    .replace(/REMETENTE.*$/gim, "")
    .replace(/PEDIDO.*$/gim, "")
    .replace(/MAGALU.*$/gim, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "Extraia SOMENTE os dados do DESTINATÁRIO. Retorne JSON válido com name, street, district, city, state, postalCode, phone, country",
      },
      {
        role: "user",
        content: cleanedText,
      },
    ],
  });

  const content = completion.choices[0]?.message?.content;

  if (!content) {
    throw new HttpsError("internal", "Resposta vazia da OpenAI");
  }

  const jsonMatch = content.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new HttpsError("internal", "JSON inválido");
  }

  return JSON.parse(jsonMatch[0]);

});


// ======================================================
// =================== GEOCODE ADDRESS ==================
// ======================================================

export const geocodeAddress = onCall(
{
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 60,
},
async (request) => {

  const { street, city, state, postalCode, country } = request.data;

  const queries = [

    [street, city, state, postalCode, country || "Brasil"]
      .filter(Boolean)
      .join(", "),

    [street, city, state, country || "Brasil"]
      .filter(Boolean)
      .join(", "),

    [postalCode, city, state, country || "Brasil"]
      .filter(Boolean)
      .join(", ")

  ];

  try {

    for (const address of queries) {

      if (!address) continue;

      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`,
        {
          headers: {
            "User-Agent": "LogiFlowApp/1.0"
          }
        }
      );

      const data:any = await response.json();

      if (data && data.length > 0) {

        return {
          latitude: parseFloat(data[0].lat),
          longitude: parseFloat(data[0].lon)
        };

      }

    }

    return {
      latitude: null,
      longitude: null
    };

  } catch (error) {

    console.error("Geocode error:", error);

    return {
      latitude: null,
      longitude: null
    };

  }

});


// ======================================================
// ================= STRIPE CONFIG ======================
// ======================================================

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY as string);
}


// ======================================================
// ============== CREATE CHECKOUT SESSION ==============
// ======================================================

export const createCheckoutSession = onCall(
{
  region: "us-central1",
  secrets: [STRIPE_SECRET_KEY],
},
async (request) => {

  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Usuário não autenticado");
  }

  const stripe = getStripe();
  const userId = request.auth.uid;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [
      {
        price: "price_1T5R45Fom5lf3GFgEjUGnXPC",
        quantity: 1,
      },
    ],
    metadata: {
      userId: userId,
    },
    subscription_data: {
      trial_period_days: 7,
      metadata: {
        userId: userId,
      },
    },
    success_url: "https://logiflow-dd382.web.app",
    cancel_url: "https://logiflow-dd382.web.app",
  });

  return {
    url: session.url,
  };

});


// ======================================================
// ===================== WEBHOOK ========================
// ======================================================

export const webhookStripe = onRequest(
{
  region: "us-central1",
  secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET],
},
async (req, res) => {

  const stripe = getStripe();

  const sig = req.headers["stripe-signature"] as string;

  if (!sig) {
    res.status(400).send("Missing Stripe signature");
    return;
  }

  let event: Stripe.Event;

  try {

    event = stripe.webhooks.constructEvent(
      req.rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET as string
    );

  } catch (err:any) {

    res.status(400).send(`Webhook Error: ${err.message}`);
    return;

  }

  const db = admin.firestore();

  switch (event.type) {

    case "checkout.session.completed": {

      const session = event.data.object as Stripe.Checkout.Session;

      const userId = session.metadata?.userId;

      if (userId) {

        await db.collection("subscriptions").doc(userId).set(
        {
          status: "trialing",
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true });

      }

      break;

    }

  }

  res.json({ received: true });

});


// ======================================================
// ============ EXPIRE TRIAL (BACKUP CHECK) ============
// ======================================================

export const expireTrialsDaily = onSchedule(
{
  schedule: "every 24 hours",
  region: "us-central1",
},
async () => {

  console.log("Trial expiration check executed.");

});