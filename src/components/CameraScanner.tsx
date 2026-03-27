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
  const streamRef = useRef<MediaStream | null>(null);
  const [loading, setLoading] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [statusText, setStatusText] = useState("Inicializando câmera...");
  const [captureLock, setCaptureLock] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function startCamera() {
      try {
        setStatusText("Abrindo câmera...");
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 }
          }
        });

        if (!mounted) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }

        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;

          videoRef.current.onloadedmetadata = async () => {
            try {
              await videoRef.current?.play();
            } catch {}

            const track = stream.getVideoTracks()[0];
            const capabilities: any = track.getCapabilities?.();
            const constraints: any = { advanced: [] as any[] };

            if (capabilities) {
              if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("continuous")) {
                constraints.advanced.push({ focusMode: "continuous" });
              }

              if (capabilities.focusDistance && typeof capabilities.focusDistance.max === "number") {
                constraints.advanced.push({ focusDistance: capabilities.focusDistance.max });
              }

              if (capabilities.zoom && typeof capabilities.zoom.max === "number" && typeof capabilities.zoom.min === "number") {
                const saferZoom = Math.max(capabilities.zoom.min, Math.min(1.4, capabilities.zoom.max));
                constraints.advanced.push({ zoom: saferZoom });
              }
            }

            if (constraints.advanced.length > 0) {
              try {
                await track.applyConstraints(constraints);
              } catch {}
            }

            setTimeout(() => {
              if (!mounted) return;
              setCameraReady(true);
              setStatusText("Centralize a etiqueta e espere a imagem ficar nítida");
            }, 900);
          };
        }
      } catch (err) {
        console.error("Erro câmera:", err);
        alert("Erro ao acessar câmera");
        setStatusText("Erro ao acessar câmera");
      }
    }

    startCamera();

    return () => {
      mounted = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  async function wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function capture() {
    if (loading || captureLock) return;
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    if (!ctx) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    if (!vw || !vh) {
      alert("Câmera ainda não está pronta");
      return;
    }

    setLoading(true);
    setCaptureLock(true);
    setStatusText("Ajustando foco...");

    try {
      await wait(650);

      const cropWidth = vw * 0.78;
      const cropHeight = cropWidth * (9 / 16);
      const startX = (vw - cropWidth) / 2;
      const startY = (vh - cropHeight) / 2;

      canvas.width = 1400;
      canvas.height = Math.round(cropHeight * (1400 / cropWidth));

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.filter = "contrast(1.28) brightness(1.06) saturate(0.2)";

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

      setStatusText("Processando etiqueta...");

      const base64 = canvas.toDataURL("image/jpeg", 0.88).split(",")[1];

      const scanLabel = httpsCallable(functions, "scanLabel");
      const res: any = await scanLabel({ imageBase64: base64 });

      if (!res?.data) {
        throw new Error("Resposta inválida do backend");
      }

      onCapture(res.data);
    } catch (e) {
      console.error("ERRO FRONTEND:", e);
      alert("Erro ao processar a imagem");
      setStatusText("Centralize a etiqueta e tente novamente");
    } finally {
      setLoading(false);
      setTimeout(() => setCaptureLock(false), 400);
    }
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
        muted
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          opacity: 0.98
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
            width: "88%",
            maxWidth: 520,
            aspectRatio: "16 / 9",
            border: "3px solid #22c55e",
            borderRadius: 20,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.30)"
          }}
        />
      </div>

      <div
        style={{
          position: "absolute",
          top: 20,
          left: "50%",
          transform: "translateX(-50%)",
          color: "white",
          background: "rgba(0,0,0,0.55)",
          border: "1px solid rgba(255,255,255,0.18)",
          padding: "10px 14px",
          borderRadius: 16,
          fontSize: 14,
          fontWeight: 700,
          maxWidth: "92%",
          textAlign: "center"
        }}
      >
        {statusText}
      </div>

      <button
        onClick={capture}
        disabled={loading || !cameraReady || captureLock}
        style={{
          position: "absolute",
          bottom: 30,
          left: "50%",
          transform: "translateX(-50%)",
          width: 74,
          height: 74,
          borderRadius: 37,
          background: loading || !cameraReady || captureLock ? "#6b7280" : "#2563eb",
          border: "4px solid white",
          opacity: loading || !cameraReady || captureLock ? 0.78 : 1
        }}
      />

      <button
        onClick={onClose}
        disabled={loading}
        style={{
          position: "absolute",
          top: 20,
          left: 20,
          color: "white",
          background: "rgba(0,0,0,0.5)",
          border: "none",
          padding: 10,
          borderRadius: 20,
          fontWeight: 700
        }}
      >
        ✕
      </button>

      <canvas ref={canvasRef} style={{ display: "none" }} />
    </div>
  );
}