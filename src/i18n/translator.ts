import type { SupportedLanguage } from "./languages";

type Dictionary = {
  [key: string]: {
    pt: string;
    en: string;
    es: string;
  };
};

const dictionary: Dictionary = {
  scan: {
    pt: "Escanear",
    en: "Scan",
    es: "Escanear"
  },
  speak: {
    pt: "Falar com LogiFlow",
    en: "Talk to LogiFlow",
    es: "Hablar con LogiFlow"
  },
  concludeDelivery: {
    pt: "Concluir Entrega",
    en: "Complete Delivery",
    es: "Finalizar Entrega"
  },
  deleteDelivery: {
    pt: "Apagar Entrega",
    en: "Delete Delivery",
    es: "Eliminar Entrega"
  },
  deliveryCompleted: {
    pt: "Entrega concluída",
    en: "Delivery completed",
    es: "Entrega finalizada"
  }
};

export const t = (
  key: keyof typeof dictionary,
  lang: SupportedLanguage
): string => {
  return dictionary[key][lang] || dictionary[key].en;
};
