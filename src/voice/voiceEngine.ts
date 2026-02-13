type StartCallback = (text: string) => void;
type ErrorCallback = (error: any) => void;

class VoiceEngine {
  private recognition: any;
  private isListening = false;
  private isSpeaking = false;
  private shouldRestart = false;
  private onResultCallback?: StartCallback;
  private onErrorCallback?: ErrorCallback;

  constructor() {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      console.error("SpeechRecognition não suportado neste navegador.");
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.lang = navigator.language || "pt-BR";
    this.recognition.continuous = true;
    this.recognition.interimResults = false;

    this.recognition.onresult = (event: any) => {
      if (this.isSpeaking) return;

      const text = event.results[event.results.length - 1][0].transcript;
      if (this.onResultCallback) {
        this.onResultCallback(text);
      }
    };

    this.recognition.onerror = (event: any) => {
      this.isListening = false;
      if (this.onErrorCallback) {
        this.onErrorCallback(event);
      }
    };

    this.recognition.onend = () => {
      this.isListening = false;

      if (this.shouldRestart && !this.isSpeaking) {
        this.startInternal();
      }
    };
  }

  private startInternal() {
    if (!this.recognition) return;
    if (this.isListening) return;

    try {
      this.recognition.start();
      this.isListening = true;
    } catch (err) {
      console.error("Erro ao iniciar reconhecimento:", err);
    }
  }

  start(onResult: StartCallback, onError?: ErrorCallback) {
    if (!this.recognition) return;

    this.onResultCallback = onResult;
    this.onErrorCallback = onError;
    this.shouldRestart = true;

    this.startInternal();
  }

  stop() {
    if (!this.recognition) return;

    this.shouldRestart = false;
    this.recognition.stop();
    this.isListening = false;
  }

  speak(text: string) {
    if (!("speechSynthesis" in window)) {
      console.error("speechSynthesis não suportado.");
      return;
    }

    try {
      this.isSpeaking = true;

      // pausa reconhecimento enquanto fala
      if (this.isListening) {
        this.recognition.stop();
        this.isListening = false;
      }

      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = navigator.language || "pt-BR";
      utterance.rate = 1;
      utterance.pitch = 1;

      utterance.onend = () => {
        this.isSpeaking = false;

        if (this.shouldRestart) {
          this.startInternal();
        }
      };

      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.error("Erro ao falar:", err);
      this.isSpeaking = false;
    }
  }

  cancelSpeak() {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      this.isSpeaking = false;
    }
  }
}

export const voiceEngine = new VoiceEngine();
