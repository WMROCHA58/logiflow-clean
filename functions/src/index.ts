import { onCall } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp();
}

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");


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
    try {
      const { imageBase64 } = request.data;

      if (!imageBase64) {
        throw new Error("imageBase64 não fornecido");
      }

      // ---------- GOOGLE VISION ----------
      const visionModule = await import("@google-cloud/vision");
      const vision = new visionModule.ImageAnnotatorClient();

      const [result] = await vision.textDetection({
        image: { content: imageBase64 },
      });

      const extractedText =
        result.textAnnotations?.[0]?.description || "";

      if (!extractedText) {
        throw new Error("Nenhum texto detectado");
      }

      // ---------- LIMPEZA DE TEXTO ----------
      const cleanedText = extractedText
        .replace(/QR[\s\S]*$/gi, "")
        .replace(/DATA\s*ENTREGA.*$/gim, "")
        .replace(/REMETENTE.*$/gim, "")
        .replace(/PEDIDO.*$/gim, "")
        .replace(/MAGALU.*$/gim, "")
        .replace(/\s{2,}/g, " ")
        .trim();

      const lines = cleanedText.split("\n");

      // ---------- CEP ----------
      const cepMatch = cleanedText.match(/\b\d{5}-?\d{3}\b/);
      const forcedCEP = cepMatch ? cepMatch[0] : "";

      // ---------- BAIRRO ----------
      let forcedDistrict = "";

      for (const line of lines) {
        const l = line.toLowerCase();
        if (
          l.includes("bairro") ||
          l.includes("chácara") ||
          l.includes("jardim") ||
          l.includes("vila")
        ) {
          forcedDistrict = line.replace(/bairro[:\s]*/i, "").trim();
          break;
        }
      }

      // ---------- OPENAI ----------
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
            content: `
Extraia SOMENTE os dados do DESTINATÁRIO de uma etiqueta brasileira.

IGNORE COMPLETAMENTE:
- QR code
- remetente
- data de entrega
- códigos de pedido
- textos promocionais

Formato típico:
Nome
Rua / Quadra / Lote / DF / Número
Bairro
Cidade - Estado
CEP
Telefone

Retorne APENAS JSON válido com:
name, street, district, city, state, postalCode, phone, country
`,
          },
          {
            role: "user",
            content: cleanedText,
          },
        ],
      });

      const content = completion.choices[0]?.message?.content;

      if (!content) {
        throw new Error("Resposta vazia da OpenAI");
      }

      const jsonMatch = content.match(/\{[\s\S]*\}/);

      if (!jsonMatch) {
        throw new Error("JSON inválido");
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        ...parsed,
        postalCode: parsed.postalCode || forcedCEP,
        district: parsed.district || forcedDistrict,
        debugRawText: cleanedText,
        debugLines: lines,
      };
    } catch (error: any) {
      console.error("SCAN ERROR:", error);
      throw new Error(error.message || "Erro interno");
    }
  }
);


// ======================================================
// ================== GEOCODE ADDRESS ===================
// ======================================================

export const geocodeAddress = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 30,
  },
  async (request) => {
    try {
      let { street, city, state, postalCode, country, district } =
        request.data;

      if (!city) {
        return { latitude: null, longitude: null };
      }

      function clean(text: string = "") {
        return text
          .replace(/LIV/gi, "")
          .replace(/QUADRA/gi, "")
          .replace(/LOTE/gi, "")
          .replace(/AO/gi, "")
          .replace(/\s+/g, " ")
          .trim();
      }

      street = clean(street);
      district = clean(district);

      async function search(query: string) {
        const url =
          "https://nominatim.openstreetmap.org/search" +
          "?format=json" +
          "&limit=1" +
          "&addressdetails=1" +
          "&q=" +
          encodeURIComponent(query);

        const response = await fetch(url, {
          headers: {
            "User-Agent": "LogiFlow-App/1.0",
            "Accept-Language": "pt-BR",
          },
        });

        if (!response.ok) return null;

        const result: any = await response.json();

        if (!result || result.length === 0) return null;

        return {
          latitude: parseFloat(result[0].lat),
          longitude: parseFloat(result[0].lon),
        };
      }

      // 1️⃣ CEP
      if (postalCode) {
        const geoCep = await search(
          `${postalCode}, ${city}, ${country || ""}`
        );
        if (geoCep) return geoCep;
      }

      // 2️⃣ Rua + Bairro
      const geoStreet = await search(
        `${street}, ${district || ""}, ${city}, ${state || ""}, ${
          country || ""
        }`
      );
      if (geoStreet) return geoStreet;

      // 3️⃣ Cidade
      const geoCity = await search(
        `${city}, ${state || ""}, ${country || ""}`
      );
      if (geoCity) return geoCity;

      return { latitude: null, longitude: null };
    } catch (error) {
      console.error("GEOCODE ERROR:", error);
      return { latitude: null, longitude: null };
    }
  }
);
