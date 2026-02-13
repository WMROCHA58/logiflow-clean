import { onCall } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp();
}

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

export const scanLabel = onCall(
  {
    region: "us-central1",
    secrets: [OPENAI_API_KEY],
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async (request) => {
    try {
      const { imageBase64 } = request.data;

      if (!imageBase64) {
        throw new Error("imageBase64 não fornecido");
      }

      // ================= GOOGLE VISION =================
      const visionModule = await import("@google-cloud/vision");
      const vision = new visionModule.ImageAnnotatorClient();

      const [result] = await vision.textDetection({
        image: { content: imageBase64 },
      });

      const extractedText =
        result.textAnnotations?.[0]?.description || "";

      if (!extractedText) {
        throw new Error("Nenhum texto detectado pela Vision API");
      }

      // ================= REGEX CEP =================
      const cepMatch = extractedText.match(/\b\d{5}-?\d{3}\b/);
      const forcedCEP = cepMatch ? cepMatch[0] : "";

      // ================= REGEX BAIRRO =================
      let forcedDistrict = "";
      const lines = extractedText.split("\n");

      for (const line of lines) {
        const l = line.toLowerCase();
        if (
          l.includes("bairro") ||
          l.includes("chácara") ||
          l.includes("jardim") ||
          l.includes("vila")
        ) {
          forcedDistrict = line.trim();
          break;
        }
      }

      // ================= OPENAI =================
      const openaiModule = await import("openai");
      const OpenAI = openaiModule.default;

      const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });

      const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Extraia os dados da etiqueta e retorne SOMENTE JSON válido com: name, street, district, city, state, postalCode, phone, country.",
          },
          {
            role: "user",
            content: extractedText,
          },
        ],
      });

      const content = completion.choices[0]?.message?.content;

      if (!content) {
        throw new Error("Resposta vazia da OpenAI");
      }

      const jsonMatch = content.match(/\{[\s\S]*\}/);

      if (!jsonMatch) {
        throw new Error("OpenAI não retornou JSON válido");
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        ...parsed,
        postalCode: parsed.postalCode || forcedCEP,
        district: parsed.district || forcedDistrict,
        debugLines: lines,
      };
    } catch (error: any) {
      console.error("ERRO SCAN:", error);
      throw new Error(error.message || "Erro interno");
    }
  }
);
