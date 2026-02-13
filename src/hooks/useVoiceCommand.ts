import { useRef, useState } from "react";

export type VoiceAction =
  | "NONE"
  | "SCAN_ADDRESS"
  | "MARK_DELIVERED"
  | "SET_LANG_EN"
  | "SET_LANG_PT"
  | "SET_LANG_ES"
  | "NEXT_DELIVERY"
  | "CANCEL";

// 🔤 remove acentos e normaliza
function normalize(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function mapVoiceToAction(text: string): VoiceAction {
  const command = normalize(text);

  if (command.includes("cancelar")) return "CANCEL";
  if (command.includes("escanear")) return "SCAN_ADDRESS";
  if (command.includes("entregue")) return "MARK_DELIVERED";

  // 🔵 NOVO COMANDO
  if (
    command.includes("proxima entrega") ||
    command.includes("próxima entrega")
  ) {
    return "NEXT_DELIVERY";
  }

  if (
    command.includes("portugues") ||
    command.includes("idioma portugues")
  ) {
    return "SET_LANG_PT";
  }

  if (
    command.includes("ingles") ||
    command.includes("english") ||
    command.includes("idioma ingles")
  ) {
    return "SET_LANG_EN";
  }

  if (
    command.includes("espanhol") ||
    command.includes("spanish") ||
    command.includes("idioma espanhol")
  ) {
    return "SET_LANG_ES";
  }

  return "NONE";
}

export function useVoiceCommand() {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [action, setAction] = useState<VoiceAction>("NONE");

  const recognitionRef = useRef<any>(null);

  const startListening = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Reconhecimento de voz não suportado");
      return;
    }

    recognitionRef.current?.abort();

    const recognition = new SpeechRecognition();
    recognition.lang = "pt-BR";
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onstart = () => {
      setIsListening(true);
      setTranscript("");
      setAction("NONE");
    };

    recognition.onresult = (event: any) => {
      const text = event.results[0][0].transcript;
      setTranscript(text);
      setAction(mapVoiceToAction(text));
      recognition.abort();
    };

    recognition.onerror = () => {
      recognition.abort();
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
  };

  const stopListening = () => {
    recognitionRef.current?.abort();
    setIsListening(false);
  };

  return {
    isListening,
    transcript,
    action,
    startListening,
    stopListening,
  };
}
