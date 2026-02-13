import { useRef, useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";

type Props = {
  onCapture: (data: any) => void;
  onClose: () => void;
};

export function CameraScanner({ onCapture, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 }
          }
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();

          const track = stream.getVideoTracks()[0];
          const capabilities: any = track.getCapabilities?.();

          if (capabilities?.focusMode) {
            track.applyConstraints({
              advanced: [{ focusMode: "continuous" }]
            } as any);
          }
        }
      } catch (err) {
        console.error("Erro câmera:", err);
        alert("Erro ao acessar câmera");
      }
    }

    startCamera();

    return () => {
      const stream = videoRef.current?.srcObject as MediaStream;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function capture() {
    if (!videoRef.current || !canvasRef.current) return;

    setLoading(true);

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      setLoading(false);
      return;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    if (!vw || !vh) {
      alert("Câmera ainda não está pronta");
      setLoading(false);
      return;
    }

    const cropWidth = vw * 0.75;
    const cropHeight = cropWidth * (3 / 4);

    const startX = (vw - cropWidth) / 2;
    const startY = (vh - cropHeight) / 2;

    canvas.width = 1280;
    canvas.height = cropHeight * (1280 / cropWidth);

    ctx.filter = "contrast(1.2) brightness(1.05)";
    ctx.drawImage(
      video,
      startX,
      startY,
      cropWidth,
      cropHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );

    const base64 = canvas.toDataURL("image/jpeg", 0.95).split(",")[1];

    try {
      const scanLabel = httpsCallable(functions, "scanLabel");

      // 🔥 CORREÇÃO CRÍTICA: nome correto do campo
      const res: any = await scanLabel({ imageBase64: base64 });

      if (!res?.data) {
        throw new Error("Resposta inválida do backend");
      }

      onCapture(res.data);
    } catch (e) {
      console.error("ERRO FRONTEND:", e);
      alert("Erro ao processar a imagem");
    }

    setLoading(false);
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "black",
        zIndex: 9999
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          opacity: 0.9
        }}
      />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          pointerEvents: "none"
        }}
      >
        <div
          style={{
            width: "80%",
            maxWidth: 340,
            aspectRatio: "4/3",
            border: "3px solid #22c55e",
            borderRadius: 20
          }}
        />
      </div>

      <button
        onClick={capture}
        disabled={loading}
        style={{
          position: "absolute",
          bottom: 30,
          left: "50%",
          transform: "translateX(-50%)",
          width: 70,
          height: 70,
          borderRadius: 35,
          background: "#2563eb",
          border: "4px solid white"
        }}
      />

      <button
        onClick={onClose}
        style={{
          position: "absolute",
          top: 20,
          left: 20,
          color: "white",
          background: "rgba(0,0,0,0.5)",
          border: "none",
          padding: 10,
          borderRadius: 20
        }}
      >
        ✕
      </button>

      <canvas ref={canvasRef} style={{ display: "none" }} />
    </div>
  );
}
