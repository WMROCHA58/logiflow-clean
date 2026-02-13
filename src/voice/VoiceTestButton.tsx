import { useState } from "react"
import { voiceEngine } from "./voiceEngine"

export default function VoiceTestButton() {
  const [transcript, setTranscript] = useState<string>("")
  const [error, setError] = useState<string>("")

  const handleStart = () => {
    setError("")

    voiceEngine.start(
      (result) => {
        const cleanText = result.trim()
        console.log("Reconhecido:", cleanText)

        setTranscript(cleanText)
        voiceEngine.speak("Você disse " + cleanText)
      },
      (err) => {
        setError(err)
      }
    )
  }

  const handleStop = () => {
    voiceEngine.stop()
  }

  return (
    <div
      style={{
        marginTop: 20,
        padding: 12,
        borderRadius: 12,
        background: "#ffffff",
        boxShadow: "0 4px 12px rgba(0,0,0,0.08)"
      }}
    >
      <div style={{ display: "flex", gap: 10 }}>
        <button
          onClick={handleStart}
          style={{
            flex: 1,
            padding: 12,
            background: "#2563eb",
            color: "white",
            border: "none",
            borderRadius: 8,
            fontWeight: "bold"
          }}
        >
          🎤 Iniciar Voz
        </button>

        <button
          onClick={handleStop}
          style={{
            flex: 1,
            padding: 12,
            background: "#ef4444",
            color: "white",
            border: "none",
            borderRadius: 8,
            fontWeight: "bold"
          }}
        >
          ⛔ Parar
        </button>
      </div>

      <div style={{ marginTop: 14 }}>
        <strong>Texto reconhecido:</strong>
        <div style={{ marginTop: 6, minHeight: 24 }}>
          {transcript || "(nenhum texto ainda)"}
        </div>
      </div>

      {error && (
        <div style={{ marginTop: 10, color: "red" }}>
          <strong>Erro:</strong> {error}
        </div>
      )}
    </div>
  )
}
