import type { SupportedLanguage } from "./languages";

export const getVoiceLocale = (lang: SupportedLanguage): string => {
  switch (lang) {
    case "pt":
      return "pt-BR";
    case "es":
      return "es-ES";
    case "en":
    default:
      return "en-US";
  }
};
