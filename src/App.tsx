import { useEffect, useState, useRef } from "react";
import { auth } from "./firebase";
import Login from "./Login";
import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  collection,
  addDoc,
  getDocs,
  query,
  where,
  Timestamp,
  updateDoc,
  doc,
  deleteDoc
} from "firebase/firestore";
import { db } from "./firebase";
import { CameraScanner } from "./components/CameraScanner";
import { voiceEngine } from "./voice/voiceEngine";
import { initUserContext } from "./modules/userContext";

type DeliveryStatus = "concluida" | "nao_realizada";

type Delivery = {
  id: string;
  name: string;
  street: string;
  district?: string;
  city: string;
  state?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
  status: DeliveryStatus;
  debugLines?: string[];
};

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const deliveriesRef = useRef<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [previewData, setPreviewData] = useState<any>(null);
  const lastSpokenDeliveryRef = useRef<Delivery | null>(null);
  const isProcessingVoiceRef = useRef(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (usr) => {
      if (usr) {
        setUser(usr);
        try {
          await initUserContext(usr.uid);
        } catch (e) {
          console.error("Erro initUserContext", e);
        }
      } else {
        setUser(null);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (user) loadDeliveries(user.uid);
  }, [user]);

  async function loadDeliveries(uid: string) {
    const q = query(collection(db, "deliveries"), where("userId", "==", uid));
    const snap = await getDocs(q);
    const list: Delivery[] = snap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Omit<Delivery, "id">)
    }));
    setDeliveries(list);
    deliveriesRef.current = list;
  }

  async function saveDelivery(data: any) {
    if (!user) return;

    await addDoc(collection(db, "deliveries"), {
      userId: user.uid,
      name: data?.name || "",
      street: data?.street || "",
      district: data?.district || "",
      city: data?.city || "",
      state: data?.state || "",
      postalCode: data?.postalCode || "",
      country: data?.country || "",
      phone: data?.phone || "",
      status: "nao_realizada",
      debugLines: data?.debugLines || [],
      createdAt: Timestamp.now()
    });

    setPreviewData(null);
    await loadDeliveries(user.uid);
  }

  async function concluirEntrega(id: string) {
    await updateDoc(doc(db, "deliveries", id), { status: "concluida" });
    if (user) await loadDeliveries(user.uid);
  }

  async function apagarEntrega(id: string) {
    await deleteDoc(doc(db, "deliveries", id));
    if (user) await loadDeliveries(user.uid);
  }

  async function apagarTodas() {
    if (!user) return;
    const snap = await getDocs(
      query(collection(db, "deliveries"), where("userId", "==", user.uid))
    );
    for (const d of snap.docs) {
      await deleteDoc(doc(db, "deliveries", d.id));
    }
    await loadDeliveries(user.uid);
  }

  async function logout() {
    await signOut(auth);
  }

  function normalize(t: string) {
    return t
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\s]/gi, "")
      .trim();
  }

  function detectIntent(t: string): "NEXT" | "REPEAT" | "COUNT" | null {
    const n = normalize(t);
    if (n.includes("quantas") || n.includes("faltam") || n.includes("restam"))
      return "COUNT";
    if (n.includes("proxima") || n.includes("seguinte")) return "NEXT";
    if (n.includes("repetir") || n.includes("de novo")) return "REPEAT";
    return null;
  }

  function handleVoice() {
    if (isProcessingVoiceRef.current) return;
    isProcessingVoiceRef.current = true;

    voiceEngine.start(
      (res: string) => {
        const intent = detectIntent(res);

        if (intent === "COUNT") {
          const p = deliveriesRef.current.filter(
            (d) => d.status === "nao_realizada"
          ).length;
          voiceEngine.speak(`Você tem ${p} entregas pendentes`);
        }

        if (intent === "NEXT") {
          const next = deliveriesRef.current.find(
            (d) => d.status === "nao_realizada"
          );
          if (!next) {
            voiceEngine.speak("Não há entregas pendentes");
          } else {
            lastSpokenDeliveryRef.current = next;
            voiceEngine.speak(
              `Próxima entrega: ${next.name}. ${next.street}, ${next.city}`
            );
          }
        }

        if (intent === "REPEAT") {
          const last = lastSpokenDeliveryRef.current;
          if (!last) {
            voiceEngine.speak("Nenhum endereço falado ainda");
          } else {
            voiceEngine.speak(
              `Repetindo: ${last.name}. ${last.street}, ${last.city}`
            );
          }
        }

        if (!intent) {
          voiceEngine.speak("Comando não reconhecido");
        }

        isProcessingVoiceRef.current = false;
      },
      () => {
        isProcessingVoiceRef.current = false;
      }
    );
  }

  if (loading) return <div style={{ padding: 30 }}>Carregando...</div>;
  if (!user) return <Login />;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f3f4f6",
        padding: 24,
        fontFamily: "Arial"
      }}
    >
      <div style={{ maxWidth: 800, margin: "0 auto" }}>
        <h1 style={{ marginBottom: 12 }}>🚚 LogiFlow</h1>

        <button onClick={logout} style={mainBtn("#6b7280")}>
          Sair
        </button>
        <button
          onClick={() => setIsScannerOpen(true)}
          style={mainBtn("#2563eb")}
        >
          📸 Escanear Etiqueta
        </button>
        <button onClick={handleVoice} style={mainBtn("#10b981")}>
          🎤 Falar com LogiFlow
        </button>
        <button onClick={apagarTodas} style={mainBtn("#111827")}>
          🗑️ Apagar Todas
        </button>

        {deliveries.map((d, i) => (
          <div
            key={d.id}
            style={{
              background: "#fff",
              padding: 18,
              borderRadius: 14,
              marginTop: 16,
              boxShadow: "0 6px 18px rgba(0,0,0,0.05)"
            }}
          >
            <strong>
              {i + 1}. {d.name}
            </strong>

            <div>{d.street}</div>

            {d.district && <div>Bairro: {d.district}</div>}

            <div>
              {d.city}
              {d.state && ` - ${d.state}`}
            </div>

            {d.postalCode && <div>CEP: {d.postalCode}</div>}

            {d.country && <div>País: {d.country}</div>}

            {d.phone && <div>📞 {d.phone}</div>}

            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                marginTop: 10
              }}
            >
              {d.phone && (
                <>
                  <a
                    href={`tel:${d.phone}`}
                    style={actionBtn("#4b5563")}
                  >
                    Ligar
                  </a>
                  <a
                    href={`https://wa.me/${d.phone}`}
                    target="_blank"
                    style={actionBtn("#25D366")}
                  >
                    WhatsApp
                  </a>
                </>
              )}
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                  d.street + " " + d.city
                )}`}
                target="_blank"
                style={actionBtn("#2563eb")}
              >
                Google
              </a>
              <a
                href={`https://waze.com/ul?q=${encodeURIComponent(
                  d.street + " " + d.city
                )}`}
                target="_blank"
                style={actionBtn("#06b6d4")}
              >
                Waze
              </a>
            </div>

            {d.status === "nao_realizada" && (
              <button
                onClick={() => concluirEntrega(d.id)}
                style={smallBtn("#16a34a")}
              >
                ✔ Concluir
              </button>
            )}

            <button
              onClick={() => apagarEntrega(d.id)}
              style={smallBtn("#b91c1c")}
            >
              🗑 Apagar
            </button>
          </div>
        ))}
      </div>

      {isScannerOpen && (
        <CameraScanner
          onCapture={(data) => {
            setIsScannerOpen(false);
            setPreviewData(data);
          }}
          onClose={() => setIsScannerOpen(false)}
        />
      )}

      {previewData && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999
          }}
        >
          <div
            style={{
              background: "#fff",
              padding: 24,
              borderRadius: 16,
              width: "95%",
              maxWidth: 420
            }}
          >
            <h3>{previewData.name}</h3>

            <p>{previewData.street}</p>

            {previewData.district && (
              <p>Bairro: {previewData.district}</p>
            )}

            <p>
              {previewData.city}
              {previewData.state && ` - ${previewData.state}`}
            </p>

            {previewData.postalCode && (
              <p>CEP: {previewData.postalCode}</p>
            )}

            {previewData.country && (
              <p>País: {previewData.country}</p>
            )}

            <button
              onClick={() => saveDelivery(previewData)}
              style={mainBtn("#16a34a")}
            >
              Salvar
            </button>
            <button
              onClick={() => setPreviewData(null)}
              style={mainBtn("#6b7280")}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function mainBtn(color: string) {
  return {
    width: "100%",
    padding: 14,
    marginBottom: 10,
    background: color,
    color: "#fff",
    border: "none",
    borderRadius: 10,
    fontSize: 15,
    fontWeight: "bold"
  };
}

function smallBtn(color: string) {
  return {
    marginTop: 10,
    padding: "6px 12px",
    background: color,
    color: "#fff",
    border: "none",
    borderRadius: 6
  };
}

function actionBtn(color: string) {
  return {
    flex: 1,
    background: color,
    padding: 8,
    color: "#fff",
    textAlign: "center" as const,
    borderRadius: 6,
    textDecoration: "none",
    fontSize: 12
  };
}
