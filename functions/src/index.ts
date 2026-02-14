import { onCall } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import admin from "firebase-admin";
import fetch from "node-fetch";

if (!admin.apps.length) {
  admin.initializeApp();
}

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

/* ===================== SCAN LABEL ===================== */

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
      if (!imageBase64) throw new Error("imageBase64 não fornecido");

      const visionModule = await import("@google-cloud/vision");
      const vision = new visionModule.ImageAnnotatorClient();

      const [result] = await vision.textDetection({
        image: { content: imageBase64 },
      });

      const extractedText =
        result.textAnnotations?.[0]?.description || "";

      if (!extractedText)
        throw new Error("Nenhum texto detectado");

      const cepMatch = extractedText.match(/\b\d{5}-?\d{3}\b/);
      const forcedCEP = cepMatch ? cepMatch[0] : "";

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
      const jsonMatch = content?.match(/\{[\s\S]*\}/);

      if (!jsonMatch)
        throw new Error("OpenAI não retornou JSON");

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        ...parsed,
        postalCode: parsed.postalCode || forcedCEP,
        district: parsed.district || forcedDistrict,
        debugLines: lines,
      };

    } catch (error: any) {
      console.error("SCAN ERROR:", error);
      throw new Error(error.message || "Erro interno");
    }
  }
);

/* ===================== GEOCODE ROBUSTO ===================== */

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

      // 🔹 Normalização leve
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

        const result: any = await response.json();

        if (!result || result.length === 0) return null;

        return {
          latitude: parseFloat(result[0].lat),
          longitude: parseFloat(result[0].lon),
        };
      }

      // 🔹 Tentativa 1 — CEP
      if (postalCode) {
        const geoCep = await search(
          `${postalCode}, ${city}, ${country || ""}`
        );
        if (geoCep) return geoCep;
      }

      // 🔹 Tentativa 2 — Rua + Bairro
      const geoStreet = await search(
        `${street}, ${district || ""}, ${city}, ${state || ""}, ${
          country || ""
        }`
      );
      if (geoStreet) return geoStreet;

      // 🔹 Tentativa 3 — Cidade
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
