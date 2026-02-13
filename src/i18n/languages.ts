export type SupportedLanguage = "pt" | "en" | "es";

export const detectUserLanguage = (): SupportedLanguage => {
  const browserLang = navigator.language.toLowerCase();

  if (browserLang.startsWith("pt")) return "pt";
  if (browserLang.startsWith("es")) return "es";
  return "en";
};
