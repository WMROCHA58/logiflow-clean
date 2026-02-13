import { useEffect, useState } from "react";
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
} from "firebase/firestore";
import { db } from "./firebase";
import { CameraScanner } from "./components/CameraScanner";

type DeliveryStatus = "concluida" | "nao_realizada";

type Delivery = {
  id: string;
  name: string;
  street: string;
  district?: string;
  city: string;
  state?: string;
  postalCode?: string;
  country: string;
  phone?: string;
  status: DeliveryStatus;
};

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [previewData, setPreviewData] = useState<any>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (user) loadDeliveries(user.uid);
  }, [user]);

  async function loadDeliveries(uid: string) {
    const q = query(collection(db, "deliveries"), where("userId", "==", uid));
    const snapshot = await getDocs(q);

    const list: Delivery[] = snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...(docSnap.data() as Omit<Delivery, "id">),
    }));

    setDeliveries(list);
  }

  async function saveDelivery(data: any) {
    if (!user) return;

    await addDoc(collection(db, "deliveries"), {
      userId: user.uid,
      ...data,
      status: "nao_realizada",
      createdAt: Timestamp.now(),
    });

    setPreviewData(null);
    await loadDeliveries(user.uid);
  }

  async function concluirEntrega(id: string) {
    await updateDoc(doc(db, "deliveries", id), {
      status: "concluida",
    });

    if (user) await loadDeliveries(user.uid);
  }

  async function concluirSelecionadas() {
    for (const id of selectedIds) {
      await updateDoc(doc(db, "deliveries", id), {
        status: "concluida",
      });
    }
    setSelectedIds([]);
    if (user) await loadDeliveries(user.uid);
  }

  async function logout() {
    await signOut(auth);
  }

  if (loading) return <div style={{ padding: 30 }}>Carregando...</div>;
  if (!user) return <Login />;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f3f4f6",
        padding: 24,
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div style={{ maxWidth: 800, margin: "0 auto" }}>
        <h1 style={{ marginBottom: 4 }}>🚚 LogiFlow</h1>
        <p style={{ color: "#6b7280", marginBottom: 16 }}>
          Logado como: {user.email}
        </p>

        <button
          onClick={logout}
          style={{
            marginBottom: 20,
            padding: "8px 14px",
            background: "#e5e7eb",
            border: "none",
            borderRadius: 6,
          }}
        >
          Sair
        </button>

        <button
          onClick={() => setIsScannerOpen(true)}
          style={{
            marginBottom: 16,
            padding: 16,
            width: "100%",
            background: "linear-gradient(90deg,#2563eb,#06b6d4)",
            color: "white",
            border: "none",
            borderRadius: 14,
            fontSize: 16,
            fontWeight: "bold",
            boxShadow: "0 6px 18px rgba(0,0,0,0.1)",
          }}
        >
          📸 Escanear Etiqueta
        </button>

        <button
          style={{
            marginBottom: 24,
            padding: 14,
            width: "100%",
            background: "linear-gradient(90deg,#10b981,#059669)",
            color: "white",
            border: "none",
            borderRadius: 14,
            fontSize: 16,
            fontWeight: "bold",
          }}
        >
          🎤 Falar com LogiFlow
        </button>

        <h2>Não realizadas</h2>

        {selectedIds.length > 0 && (
          <button
            onClick={concluirSelecionadas}
            style={{
              marginBottom: 16,
              padding: 10,
              background: "#ef4444",
              color: "white",
              border: "none",
              borderRadius: 8,
            }}
          >
            ✔ Marcar Selecionadas como Concluídas
          </button>
        )}

        {deliveries
          .filter((d) => d.status === "nao_realizada")
          .map((d) => (
            <div key={d.id} style={{ display: "flex", gap: 10 }}>
              <input
                type="checkbox"
                checked={selectedIds.includes(d.id)}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSelectedIds([...selectedIds, d.id]);
                  } else {
                    setSelectedIds(
                      selectedIds.filter((id) => id !== d.id)
                    );
                  }
                }}
              />
              <div style={{ flex: 1 }}>
                <Card
                  delivery={d}
                  onConcluir={() => concluirEntrega(d.id)}
                />
              </div>
            </div>
          ))}

        <h2 style={{ marginTop: 30 }}>Concluídas</h2>

        {deliveries
          .filter((d) => d.status === "concluida")
          .map((d) => (
            <Card key={d.id} delivery={d} />
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
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "white",
              padding: 24,
              borderRadius: 16,
              width: "95%",
              maxWidth: 420,
            }}
          >
            <h3>{previewData.name}</h3>
            <p>{previewData.street}</p>
            {previewData.district && <p>{previewData.district}</p>}
            <p>
              {previewData.city}
              {previewData.state && ` - ${previewData.state}`}
            </p>
            {previewData.postalCode && (
              <p style={{ fontWeight: "bold", color: "#2563eb" }}>
                {previewData.postalCode}
              </p>
            )}
            <p>{previewData.country}</p>
            {previewData.phone && <p>📞 {previewData.phone}</p>}

            <button
              onClick={() => saveDelivery(previewData)}
              style={{
                marginTop: 16,
                width: "100%",
                padding: 12,
                background: "green",
                color: "white",
                border: "none",
                borderRadius: 8,
              }}
            >
              Enviar para Lista
            </button>

            <button
              onClick={() => setPreviewData(null)}
              style={{
                marginTop: 8,
                width: "100%",
                padding: 10,
                background: "#ccc",
                border: "none",
                borderRadius: 8,
              }}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function actionBtn(color: string) {
  return {
    flex: 1,
    background: color,
    padding: 8,
    color: "white",
    textAlign: "center" as const,
    borderRadius: 6,
    textDecoration: "none",
    fontSize: 12,
  };
}

function Card({
  delivery,
  onConcluir,
}: {
  delivery: Delivery;
  onConcluir?: () => void;
}) {
  return (
    <div
      style={{
        background: "#ffffff",
        padding: 18,
        borderRadius: 14,
        marginBottom: 16,
        boxShadow: "0 6px 18px rgba(0,0,0,0.05)",
      }}
    >
      <strong>{delivery.name}</strong>

      <div style={{ marginTop: 6, fontSize: 14 }}>
        <div>{delivery.street}</div>
        {delivery.district && <div>{delivery.district}</div>}
        <div>
          {delivery.city}
          {delivery.state && ` - ${delivery.state}`}
        </div>
        {delivery.postalCode && (
          <div style={{ fontWeight: "bold", color: "#2563eb" }}>
            {delivery.postalCode}
          </div>
        )}
        <div>{delivery.country}</div>
        {delivery.phone && <div>📞 {delivery.phone}</div>}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
        {delivery.phone && (
          <>
            <a href={`tel:${delivery.phone}`} style={actionBtn("#4b5563")}>
              Ligar
            </a>
            <a
              href={`https://wa.me/${delivery.phone}`}
              target="_blank"
              style={actionBtn("#25D366")}
            >
              WhatsApp
            </a>
          </>
        )}

        <a
          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
            delivery.street + " " + delivery.city
          )}`}
          target="_blank"
          style={actionBtn("#2563eb")}
        >
          Google
        </a>

        <a
          href={`https://waze.com/ul?q=${encodeURIComponent(
            delivery.street + " " + delivery.city
          )}`}
          target="_blank"
          style={actionBtn("#06b6d4")}
        >
          Waze
        </a>
      </div>

      {delivery.status === "nao_realizada" && onConcluir && (
        <button
          onClick={onConcluir}
          style={{
            marginTop: 10,
            padding: "6px 12px",
            background: "green",
            color: "white",
            border: "none",
            borderRadius: 6,
          }}
        >
          ✔ Concluir
        </button>
      )}
    </div>
  );
}
