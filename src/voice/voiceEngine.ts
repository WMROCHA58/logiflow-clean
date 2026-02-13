type StartCallback = (text: string) => void;
type ErrorCallback = (error: any) => void;

export class VoiceEngine {
  private recognition: any = null;
  private isListening = false;
  private isSpeaking = false;
  private shouldKeepListening = false;
  private onResultCallback?: StartCallback;
  private onErrorCallback?: ErrorCallback;

  constructor() {
    this.initRecognition();
  }

  private initRecognition() {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      console.error("SpeechRecognition não suportado.");
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.lang = navigator.language || "en-US";

    // 🔥 ANDROID SAFE MODE
    this.recognition.continuous = false;
    this.recognition.interimResults = false;

    this.recognition.onresult = (event: any) => {
      const text = event.results[0][0].transcript;

      if (this.onResultCallback) {
        this.onResultCallback(text);
      }
    };

    this.recognition.onend = () => {
      this.isListening = false;

      // 🔥 RESTART AUTOMÁTICO
      if (this.shouldKeepListening && !this.isSpeaking) {
        this.startInternal();
      }
    };

    this.recognition.onerror = (event: any) => {
      this.isListening = false;

      if (this.onErrorCallback) {
        this.onErrorCallback(event);
      }

      if (this.shouldKeepListening) {
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
    } catch {}
  }

  start(onResult: StartCallback, onError?: ErrorCallback) {
    if (!this.recognition) return;

    this.onResultCallback = onResult;
    this.onErrorCallback = onError;
    this.shouldKeepListening = true;

    this.startInternal();
  }

  stop() {
    if (!this.recognition) return;

    this.shouldKeepListening = false;

    try {
      this.recognition.stop();
    } catch {}

    this.isListening = false;
  }

  speak(text: string) {
    if (!("speechSynthesis" in window)) return;

    this.isSpeaking = true;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = navigator.language || "en-US";

    utterance.onend = () => {
      this.isSpeaking = false;

      // 🔥 VOLTA A OUVIR APÓS FALAR
      if (this.shouldKeepListening) {
        this.startInternal();
      }
    };

    window.speechSynthesis.speak(utterance);
  }

  cancelSpeak() {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      this.isSpeaking = false;
    }
  }
}
