import pt from "./pt.json";
import en from "./en.json";
import es from "./es.json";

export type SupportedLanguage = "pt" | "en" | "es";

const messages: Record<SupportedLanguage, any> = {
  pt,
  en,
  es,
};

function detectLanguage(): SupportedLanguage {
  const browserLang = navigator.language.slice(0, 2);

  if (browserLang === "pt") return "pt";
  if (browserLang === "es") return "es";
  return "en"; // fallback global
}

let currentLanguage: SupportedLanguage = detectLanguage();

// 🔹 Função interna para forçar idioma apenas em desenvolvimento
function getDevLanguageOverride(): SupportedLanguage | null {
  if (import.meta.env.DEV) {
    // altere aqui apenas se quisermos forçar teste
    return null;
  }
  return null;
}

const devOverride = getDevLanguageOverride();
if (devOverride) {
  currentLanguage = devOverride;
}

export function t(key: string, vars?: Record<string, string | number>) {
  const parts = key.split(".");
  let value: any = messages[currentLanguage];

  for (const part of parts) {
    value = value?.[part];
  }

  if (!value) return key;

  if (vars) {
    Object.keys(vars).forEach((k) => {
      value = value.replace(`{{${k}}}`, String(vars[k]));
    });
  }

  return value;
}

export function getCurrentLanguage(): SupportedLanguage {
  return currentLanguage;
}

export function setLanguage(lang: SupportedLanguage) {
  currentLanguage = lang;
}
