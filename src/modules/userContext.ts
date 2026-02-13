import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";

export type UserContext = {
  country: string;
  language: string;
  units: "km" | "miles";
  createdAt: any;
};

function detectLanguage(): string {
  if (typeof navigator !== "undefined" && navigator.language) {
    return navigator.language;
  }
  return "en-US";
}

function detectCountry(language: string): string {
  const parts = language.split("-");
  return parts[1]?.toUpperCase() || "US";
}

function detectUnits(country: string): "km" | "miles" {
  const milesCountries = ["US", "GB"];
  return milesCountries.includes(country) ? "miles" : "km";
}

/**
 * Cria ou garante o contexto do usuário no Firestore.
 * Versão robusta e idempotente.
 */
export async function initUserContext(uid: string): Promise<UserContext> {
  if (!uid) {
    throw new Error("UID inválido ao inicializar contexto");
  }

  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);

  // 🔥 Se já existir e tiver os campos principais, retorna
  if (snap.exists() && snap.data()?.country) {
    return snap.data() as UserContext;
  }

  const language = detectLanguage();
  const country = detectCountry(language);
  const units = detectUnits(country);

  const context: UserContext = {
    country,
    language,
    units,
    createdAt: serverTimestamp()
  };

  // 🔥 Usa merge true para evitar qualquer bloqueio estrutural
  await setDoc(ref, context, { merge: true });

  return context;
}
