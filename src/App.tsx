import { useEffect, useState, useRef, useMemo } from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import { auth } from "./firebase";
import Login from "./Login";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { collection, addDoc, getDocs, query, where, Timestamp, updateDoc, doc, deleteDoc, onSnapshot, getDoc, setDoc } from "firebase/firestore";
import { db, functions } from "./firebase";
import { httpsCallable } from "firebase/functions";
import { CameraScanner } from "./components/CameraScanner";
import { VoiceEngine } from "./voice/voiceEngine";
import { initUserContext } from "./modules/userContext";

type DeliveryStatus = "concluida" | "nao_realizada";
type Delivery = { id: string; createdAt?: any; name?: string; street?: string; district?: string; city?: string; state?: string; postalCode?: string; country?: string; phone?: string; latitude?: number | null; longitude?: number | null; status: DeliveryStatus };

export default function App() {
  const [user, setUser] = useState<any>(null);
  // ADMIN MASTER
  const ADMIN_EMAIL = "williamwmr52@gmail.com";
  const isAdmin = user?.email === ADMIN_EMAIL;

  const [all, setAll] = useState<Delivery[]>([]);
  const [mode, setMode] = useState<"operacao" | "historico" | "proxima">("operacao");
  const [routeList, setRouteList] = useState<Delivery[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [offline, setOffline] = useState(
    typeof navigator !== "undefined" ? !navigator.onLine : false
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(null);
  const [arrived, setArrived] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [autoMode, setAutoMode] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const [signDelivery, setSignDelivery] = useState<string | null>(null);
  const [distanceKm, setDistanceKm] = useState(0);
  const [fuelCost, setFuelCost] = useState(0);
  const [screen, setScreen] = useState<"operacao" | "financeiro">("operacao");
  const [config, setConfig] = useState(() => {
    const saved = localStorage.getItem("lf_financial_config");
    return saved
      ? JSON.parse(saved)
      : {
          vehicleType: "Moto",
          consumption: 30,
          fuelType: "Gasoline",
          fuelPrice: 6.0,
          currency: "R$",
          unit: "km",
          perDelivery: 8.0,
          fixedCost: 0,
        };
  });

  // Estados para assinatura
  const [subscriptionStatus, setSubscriptionStatus] = useState<string | null>(null);
  const [checkingSubscription, setCheckingSubscription] = useState(true);

  const lastPosRef = useRef<{ lat: number; lon: number } | null>(null);
  const voiceRef = useRef<VoiceEngine | null>(null);
  const autoNavRef = useRef<string | null>(null);
  const lastDistanceRef = useRef<number | null>(null);
  const lastRouteCalcRef = useRef<number>(0);

  useEffect(() => {
    localStorage.setItem("lf_financial_config", JSON.stringify(config));
  }, [config]);

  function calcDistance(aLat: number, aLon: number, bLat: number, bLon: number) {
    const R = 6371;
    const dLat = (bLat - aLat) * Math.PI / 180;
    const dLon = (bLon - aLon) * Math.PI / 180;
    const x =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(aLat * Math.PI / 180) *
      Math.cos(bLat * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  // ========== GPS WATCH POSITION (PAUSADO QUANDO SCANNER ABERTO) ==========
  useEffect(() => {
    if (!navigator.geolocation) return;

    if (isScannerOpen) return;

    const id = navigator.geolocation.watchPosition(p => {
      const coords = { lat: p.coords.latitude, lon: p.coords.longitude };
      setPos(coords);

      if (lastPosRef.current) {
        const d = calcDistance(
          lastPosRef.current.lat,
          lastPosRef.current.lon,
          coords.lat,
          coords.lon
        );
        if (d > 0.01) {
          setDistanceKm(prev => {
            const newDist = prev + d;
            const litros = newDist / config.consumption;
            const cost = litros * config.fuelPrice;
            setFuelCost(cost);
            return newDist;
          });
        }
      }
      lastPosRef.current = coords;
    });

    return () => navigator.geolocation.clearWatch(id);
  }, [config, isScannerOpen]);

  useEffect(() => {
    const on = () => { setOffline(false); syncQueue(); };
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  async function syncQueue() {
    if (!navigator.onLine) return;
    const q = JSON.parse(localStorage.getItem("lf_queue") || "[]");
    for (const a of q) {
      try {
        if (a.type === "update") await updateDoc(doc(db, "deliveries", a.id), a.data);
        if (a.type === "delete") await deleteDoc(doc(db, "deliveries", a.id));
      } catch { }
    }
    localStorage.removeItem("lf_queue");
    user && load(user.uid);
  }

  useEffect(() => { if (!voiceRef.current) voiceRef.current = new VoiceEngine(); }, []);

  useEffect(() => {
    const u = onAuthStateChanged(auth, async x => {
      if (x) { setUser(x); await initUserContext(x.uid); } else setUser(null);
      setLoading(false);
    });
    return () => u();
  }, []);

  // ========== LISTA DE ENTREGAS EM TEMPO REAL ==========
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, "deliveries"),
      where("userId", "==", user.uid)
    );

    const unsub = onSnapshot(q, snap => {
      setAll(
        snap.docs.map(d => ({
          id: d.id,
          ...(d.data() as any)
        }))
      );
    });

    return () => unsub();
  }, [user]);

  // ========== MONITORAMENTO DE ASSINATURA ==========
  useEffect(() => {
    if (!user) return;

    const ref = doc(db, "subscriptions", user.uid);

    const unsub = onSnapshot(
      ref,
      async (snap) => {

        if (!snap.exists()) {
          console.log("🆕 Novo usuário → criando trial automático");

          const trialEnd = Timestamp.fromDate(
            new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          );

          await setDoc(ref, {
            status: "trialing",
            trialEndsAt: trialEnd,
            createdAt: Timestamp.now()
          });

          setSubscriptionStatus("trialing");
          setCheckingSubscription(false);
          return;
        }

        const data = snap.data();

        if (!data) {
          console.warn("Documento de assinatura vazio — aguardando atualização");
          setSubscriptionStatus("trialing");
          setCheckingSubscription(false);
          return;
        }

        if (data.status === "trialing" && data.trialEndsAt) {
          const now = Timestamp.now();

          if (data.trialEndsAt.seconds < now.seconds) {
            setSubscriptionStatus("expired");
          } else {
            setSubscriptionStatus("trialing");
          }

        } else if (data.status === "active") {
          setSubscriptionStatus("active");

        } else {
          setSubscriptionStatus("expired");
        }

        setCheckingSubscription(false);
      },
      (error) => {
        console.error("Erro ao ouvir assinatura:", error);
        setSubscriptionStatus("expired");
        setCheckingSubscription(false);
      }
    );

    return () => unsub();
  }, [user]);

  const pendentes = useMemo(() => all.filter(d => d.status === "nao_realizada"), [all]);
  const concluidas = useMemo(() => all.filter(d => d.status === "concluida"), [all]);

  const hoje = useMemo(() => {
    const s = new Date(); s.setHours(0, 0, 0, 0);
    const e = new Date(); e.setHours(23, 59, 59, 999);
    return all.filter(d => {
      const t = d.createdAt?.toDate?.();
      return t && t >= s && t <= e;
    });
  }, [all]);

  const concluidasHoje = hoje.filter(d => d.status === "concluida");
  const faltamHoje = hoje.filter(d => d.status === "nao_realizada");

  // ========== LÓGICA DA PRÓXIMA ENTREGA ==========
  const proxima = useMemo(() => {
    if (routeList && routeList.length > 0) return routeList[0];
    if (pendentes && pendentes.length > 0) return pendentes[0];
    return null;
  }, [routeList, pendentes]);

  function km(a: number, b: number, c: number, d: number) {
    const R = 6371;
    const dLat = (c - a) * Math.PI / 180;
    const dLon = (d - b) * Math.PI / 180;
    const x = Math.sin(dLat / 2) ** 2 +
      Math.cos(a * Math.PI / 180) *
      Math.cos(c * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  const distancia =
    proxima &&
    pos &&
    proxima.latitude != null &&
    proxima.longitude != null
      ? km(pos.lat, pos.lon, proxima.latitude, proxima.longitude)
      : null;
  const eta = distancia ? Math.max(1, Math.round((distancia / 30) * 60)) : null;

  // ========== CORREÇÃO 1: AJUSTE DO LIMIAR DE CHEGADA ==========
  useEffect(() => {
    if (distancia == null) {
      setArrived(false);
      return;
    }
    setArrived(distancia <= 0.18); // 180 metros
  }, [distancia]);

  // ========== CORREÇÃO 2: RECÁLCULO AUTOMÁTICO DE ROTA ==========
  useEffect(() => {
    if (distancia == null) return;

    if (
      lastDistanceRef.current !== null &&
      distancia > lastDistanceRef.current + 0.5
    ) {
      console.log("Motorista saiu da rota — recalculando rota");
      recalcRotaDinamica();
    }

    lastDistanceRef.current = distancia;
  }, [distancia]);

  useEffect(() => {
    if (mode !== "proxima") return;

    const n = (routeList || pendentes)[0];
    if (!n) return;

    if (!n.street) return;

    if (autoNavRef.current === n.id) return;
    autoNavRef.current = n.id;

    const destino = encodeURIComponent(
      [n.street, n.district, n.city, n.state, n.postalCode, n.country]
        .filter(Boolean)
        .join(", ")
    );

    window.open(
      `https://www.google.com/maps/dir/?api=1&destination=${destino}`,
      "_self"
    );
  }, [mode, routeList, pendentes]);

  function handleRoute() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(p => {
      const { latitude, longitude } = p.coords;
      const sorted = [...pendentes]
        .filter(d => d.latitude != null && d.longitude != null)
        .sort((a, b) =>
          ((a.latitude! - latitude) ** 2 + (a.longitude! - longitude) ** 2) -
          ((b.latitude! - latitude) ** 2 + (b.longitude! - longitude) ** 2)
        );
      setRouteList(sorted.length ? sorted : null);
    });
  }

  // ========== recalcRotaDinamica (sem filtrar) ==========
  function recalcRotaDinamica() {
    if (!pendentes.length) {
      setRouteList(null);
      return;
    }

    if (!pos) {
      setRouteList(pendentes);
      return;
    }

    const sorted = [...pendentes].sort((a, b) => {
      // Coloca entregas sem coordenadas no final da lista
      if (a.latitude == null || a.longitude == null) return 1;
      if (b.latitude == null || b.longitude == null) return -1;

      return (
        ((a.latitude! - pos.lat) ** 2 + (a.longitude! - pos.lon) ** 2) -
        ((b.latitude! - pos.lat) ** 2 + (b.longitude! - pos.lon) ** 2)
      );
    });

    setRouteList(sorted);
  }

  // ========== FUNÇÃO VOLTAR AO APP ==========
  function voltarAoApp() {
    const lista = routeList || pendentes;

    if (!lista || lista.length === 0) {
      window.location.href = location.origin;
      return;
    }

    const atual = lista[0];

    if (atual && atual.status === "nao_realizada") {
      concluir(atual.id);
      return;
    }

    window.location.href = location.origin;
  }

  // ========== FUNÇÃO ACAMINHO CORRIGIDA ==========
  function aCaminho(d: Delivery) {
    if (!pos || !d.phone) return;

    const mapsLink = `https://www.google.com/maps?q=${pos.lat},${pos.lon}`;
    const mensagem =
`Olá, estou a caminho da sua entrega.

Endereço:
${d.street || ""}, ${d.city || ""}

Localização do entregador:
${mapsLink}`;

    let phone = d.phone.replace(/\D/g, "");

    if (!phone.startsWith("55")) {
      phone = "55" + phone;
    }

    const url = `https://wa.me/${phone}?text=${encodeURIComponent(mensagem)}`;

    window.open(url, "_blank");
  }

  function handleVoice() {
    try { (voiceRef.current as any)?.abort?.(); } catch { }
    voiceRef.current?.start(async (txt: string) => {
      const t = txt.toLowerCase();
      if (t.includes("quantas") || t.includes("faltam")) {
        voiceRef.current?.speak(`Você tem ${pendentes.length} entregas pendentes`);
        return;
      }
      if (t.includes("proxima") || t.includes("próxima")) {
        const n = (routeList || pendentes)[0];
        if (!n) { voiceRef.current?.speak("Não há entregas pendentes"); return; }
        voiceRef.current?.speak(`Próxima entrega: ${n.name || "Destinatário"}, ${n.street || ""}, ${n.city || ""}`);
        return;
      }
      voiceRef.current?.speak("Comando não reconhecido");
    });
  }

  async function concluir(id: string) {
    await updateDoc(doc(db, "deliveries", id), { status: "concluida" });
    recalcRotaDinamica();
    if (autoMode) {
      setTimeout(() => { setMode("proxima"); }, 2000);
    }
  }

  async function apagar(id: string) {
    try {
      await deleteDoc(doc(db, "deliveries", id));
      setExpanded(null);
    } catch (err) {
      console.error("Erro ao apagar entrega:", err);
    }
  }

  async function apagarTodasPendentes() {
    for (const d of pendentes) await apagar(d.id);
  }

  async function apagarTodasConcluidas() {
    for (const d of concluidas) await apagar(d.id);
  }

  async function tirarProva(id: string) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.capture = "environment";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        await updateDoc(doc(db, "deliveries", id), { proofImage: reader.result });
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }

  function handleFileImport(e: any) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImportText(String(reader.result || ""));
    reader.readAsText(file);
  }

  async function importarLista() {
    if (!user || !importText.trim()) return;
    const linhas = importText.split("\n").map(l => l.trim()).filter(Boolean);
    for (const linha of linhas) {
      let phoneMatch = linha.match(/(\+?\d{10,13})/);
      let phone = phoneMatch ? phoneMatch[1] : undefined;
      let texto = phone ? linha.replace(phone, "").trim() : linha;
      const partes = texto.split(/[-;,]/).map(p => p.trim()).filter(Boolean);
      const name = partes[0] || "Destinatário";
      const street = partes.slice(1).join(" ") || texto;
      try {
        const geo = httpsCallable(functions, "geocodeAddress");
        const g: any = await geo({ street });
        await addDoc(collection(db, "deliveries"), {
          userId: user.uid, name, street, phone,
          latitude: g.data.latitude || null,
          longitude: g.data.longitude || null,
          status: "nao_realizada",
          createdAt: Timestamp.now()
        });
      } catch { }
    }
    setImportText("");
    setImportOpen(false);
  }

  // ===== FUNÇÃO SAVE CORRIGIDA (sem setAll manual) =====
  async function save(data: any) {
    if (!user) return;

    if (!data.street) {
      alert("Endereço não identificado pelo scanner.");
      return;
    }

    const geo = httpsCallable(functions, "geocodeAddress");

    let g: any = { data: {} };

    try {
      // Primeira tentativa com campos individuais
      g = await geo({
        street: data.street,
        city: data.city,
        state: data.state,
        postalCode: data.postalCode,
        country: data.country
      });

      // Se não retornou coordenadas, tentar novamente com endereço completo
      if (!g.data?.latitude || !g.data?.longitude) {
        const fullAddress = [
          data.street,
          data.district,
          data.city,
          data.state,
          data.postalCode,
          data.country
        ]
          .filter(Boolean)
          .join(", ");

        const retry: any = await geo({
          street: fullAddress
        });

        if (retry.data?.latitude && retry.data?.longitude) {
          g = retry;
        }
      }
    } catch (e) {
      console.warn("Geocode falhou completamente");
    }

    await addDoc(collection(db, "deliveries"), {
      ...data,
      userId: user.uid,
      latitude: g.data.latitude || null,
      longitude: g.data.longitude || null,
      status: "nao_realizada",
      createdAt: Timestamp.now()
    });

    // Não precisa mais setPreview(null)
  }

  function formatAddress(d: Delivery) {
    const rua = d.street?.trim();
    const bairro = d.district?.trim();
    const cidadeEstado = d.city && d.state ? `${d.city} — ${d.state}` : d.city || d.state || "";
    const cep = d.postalCode?.trim();
    const pais = d.country?.trim() || "Brasil";
    const linhas: string[] = [];
    if (rua) linhas.push(rua);
    if (bairro && cidadeEstado) {
      linhas.push(`${bairro} — ${cidadeEstado}`);
    } else if (bairro) {
      linhas.push(bairro);
    } else if (cidadeEstado) {
      linhas.push(cidadeEstado);
    }
    if (cep) {
      linhas.push(`CEP: ${cep} — ${pais}`);
    } else {
      linhas.push(pais);
    }
    return linhas;
  }

  function startVoiceDestination() {
    if (!user) { alert("Faça login primeiro"); return; }
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) { alert("Seu navegador não suporta reconhecimento de voz"); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = "pt-BR";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.start();

    recognition.onresult = async (event: any) => {
      let text = event.results[0][0].transcript.toLowerCase();
      const numeros: Record<string, string> = {
        zero: "0", um: "1", dois: "2", três: "3", tres: "3",
        quatro: "4", cinco: "5", seis: "6", sete: "7",
        oito: "8", nove: "9", dez: "10"
      };
      Object.keys(numeros).forEach(p => {
        const r = new RegExp(`\\b${p}\\b`, "gi");
        text = text.replace(r, numeros[p]);
      });
      text = text
        .replace(/\bqd\b/gi, "quadra")
        .replace(/\blt\b/gi, "lote")
        .replace(/\bqdrs\b/gi, "quadra rs")
        .replace(/\bch\b/gi, "chácara")
        .replace(/\bst\b/gi, "setor")
        .replace(/\bvl\b/gi, "vila")
        .replace(/\s+/g, " ")
        .trim();
      if (!/goiania/i.test(text)) text += ", Goiânia";
      if (!/go\b/i.test(text)) text += " - GO";
      if (!/brasil/i.test(text)) text += ", Brasil";

      const tentativas = [
        text,
        text.replace(/chácara.*?,/i, ""),
        text.replace(/quadra.*?,/i, ""),
        text.replace(/lote.*?,/i, ""),
        text.split(",")[0]
      ];

      let entregaCriada = false;

      try {
        const geo = httpsCallable(functions, "geocodeAddress");
        let data: any = null;
        let finalText = text;

        for (const t of tentativas) {
          try {
            const r: any = await geo({ street: t, lat: pos?.lat ?? null, lon: pos?.lon ?? null });
            if (r.data?.latitude != null && r.data?.longitude != null) {
              data = r.data;
              finalText = t;
              break;
            }
          } catch { }
        }

        if (data) {
          const newDelivery = {
            userId: user.uid,
            name: "Destino por voz",
            street: finalText,
            latitude: data.latitude,
            longitude: data.longitude,
            status: "nao_realizada" as const,
            createdAt: Timestamp.now()
          };
          await addDoc(collection(db, "deliveries"), newDelivery);
          entregaCriada = true;
        }
      } catch (error) {
        console.error("Erro ao processar geocodificação (ignorado):", error);
      }

      const destino = encodeURIComponent(text);
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${destino}`, "_self");
      if (entregaCriada) { }
    };

    recognition.onerror = (e: any) => {
      console.error("Erro no reconhecimento de voz:", e.error);
      alert("Erro no reconhecimento: " + e.error);
    };
  }

  // ========== CORREÇÃO 3 — botão Próxima (sem filtro) ==========
  function startNextDeliveryNavigation() {
    const listaBase =
      routeList && routeList.length > 0
        ? routeList
        : pendentes;

    if (!listaBase || listaBase.length === 0) {
      alert("Não há entregas pendentes");
      return;
    }

    // Remove o filtro que exigia latitude/longitude
    const lista = listaBase;

    if (lista.length === 0) {
      alert("Não há entregas pendentes");
      return;
    }

    const n = lista[0];

    const endereco = [
      n.street,
      n.district,
      n.city,
      n.state,
      n.postalCode,
      n.country
    ]
      .filter(Boolean)
      .join(", ");

    if (!endereco) {
      alert("Endereço inválido");
      return;
    }

    const destino = encodeURIComponent(endereco);

    window.open(
      `https://www.google.com/maps/dir/?api=1&destination=${destino}`,
      "_self"
    );
  }

  // ========== COMPONENTE DO BANNER DE TESTE (TRIAL) ==========
  function TrialBanner({ user }: { user: any }) {
    const [daysLeft, setDaysLeft] = useState<number | null>(null);

    useEffect(() => {
      if (!user) return;

      const ref = doc(db, "subscriptions", user.uid);

      const unsub = onSnapshot(ref, (snap) => {
        if (!snap.exists()) return;

        const data = snap.data();

        if (!data || data.status !== "trialing" || !data.trialEndsAt) {
          setDaysLeft(null);
          return;
        }

        const end = data.trialEndsAt.toDate();
        const now = new Date();

        const diffMs = end.getTime() - now.getTime();
        const diff = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        setDaysLeft(diff > 0 ? diff : 0);
      });

      return () => unsub();
    }, [user]);

    if (daysLeft === null) return null;

    if (daysLeft === 0) {
      return (
        <div style={{
          background: "#dc2626",
          color: "#fff",
          padding: "12px",
          margin: "8px 12px",
          borderRadius: 12,
          fontWeight: 700,
          textAlign: "center"
        }}>
          ⛔ Seu teste gratuito expirou — assine para continuar
        </div>
      );
    }

    if (daysLeft <= 2) {
      return (
        <div style={{
          background: "#f59e0b",
          color: "#000",
          padding: "12px",
          margin: "8px 12px",
          borderRadius: 12,
          fontWeight: 800,
          textAlign: "center"
        }}>
          ⚠️ Últimos {daysLeft} dia{daysLeft !== 1 ? "s" : ""} do teste gratuito
        </div>
      );
    }

    return (
      <div style={{
        background: "#22c55e",
        color: "#000",
        padding: "10px",
        margin: "8px 12px",
        borderRadius: 12,
        fontWeight: 700,
        textAlign: "center"
      }}>
        🧪 Teste gratuito — {daysLeft} dia{daysLeft !== 1 ? "s" : ""} restantes
      </div>
    );
  }

  // ========== CONTROLE DE ACESSO ==========
  if (loading) {
    return <div style={{ padding: 30 }}>Carregando...</div>;
  }

  if (!user) {
    return <Login />;
  }

  if (checkingSubscription && !isAdmin) {
    return <div style={{ padding: 30 }}>Verificando assinatura...</div>;
  }

  const allowed = isAdmin || subscriptionStatus === "active" || subscriptionStatus === "trialing";

  if (!allowed && !isAdmin) {
    const createCheckout = httpsCallable(functions, "createCheckoutSession");

    const handleSubscribe = async () => {
      try {
        const result = await createCheckout();
        const { url } = result.data as { url: string };
        window.location.href = url;
      } catch (error) {
        console.error("Erro ao criar sessão de checkout:", error);
        alert("Não foi possível iniciar o pagamento. Tente novamente.");
      }
    };

    return (
      <div style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        textAlign: "center",
        padding: 20
      }}>
        <img
          src="/LogiFlow-Pro.png"
          alt="LogiFlow"
          style={{
            height: "clamp(32px, 6vw, 48px)",
            width: "auto",
            maxWidth: "60%",
            objectFit: "contain",
            display: "block",
            marginTop: 6
          }}
        />
        <h2>Assinatura necessária</h2>
        <p>
          Seu período de teste expirou ou não há assinatura ativa.
        </p>
        <button
          style={{
            background: "#2563eb",
            color: "#fff",
            padding: "14px 22px",
            borderRadius: 12,
            fontWeight: 700,
            border: "2px solid #000"
          }}
          onClick={handleSubscribe}
        >
          Assinar agora
        </button>
      </div>
    );
  }

  // ========== TELA FINANCEIRA ==========
  if (screen === "financeiro") {
    const fuelUsed = distanceKm / config.consumption;
    const revenue = concluidas.length * config.perDelivery;
    const fuelCostCalc = fuelUsed * config.fuelPrice;
    const profit = revenue - fuelCostCalc - config.fixedCost;

    return (
      <div style={{
        padding: 20,
        background: darkMode ? "#111827" : "#f3f4f6",
        minHeight: "100vh",
        color: darkMode ? "#fff" : "#000",
        boxSizing: "border-box"
      }}>
        <button
          style={{
            background: "#374151",
            color: "#fff",
            height: 52,
            width: "100%",
            border: "2px solid #000",
            borderRadius: 14,
            fontWeight: 700,
            marginBottom: 16,
            boxSizing: "border-box"
          }}
          onClick={() => setScreen("operacao")}
        >
          ← Voltar para operação
        </button>

        <h2>💰 Finanças do Dia</h2>

        <div style={{
          background: darkMode ? "#1f2937" : "#374151",
          padding: 16,
          borderRadius: 16,
          marginBottom: 16,
          color: "#fff",
          boxSizing: "border-box"
        }}>
          <h3 style={{ marginBottom: 12, color: "#fff" }}>⚙️ Configuração do veículo</h3>

          <label style={{ display: "block", marginBottom: 4, fontWeight: 600, color: "#ccc" }}>Tipo de veículo</label>
          <select
            value={config.vehicleType}
            onChange={(e) => setConfig({ ...config, vehicleType: e.target.value })}
            style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "2px solid #000", background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000", boxSizing: "border-box" }}
          >
            <option>Moto</option>
            <option>Carro</option>
            <option>Van</option>
            <option>Bicicleta elétrica</option>
          </select>

          <label style={{ display: "block", marginBottom: 4, fontWeight: 600, color: "#ccc" }}>Consumo (km por litro)</label>
          <input
            type="number"
            step="0.1"
            value={config.consumption}
            onChange={(e) => setConfig({ ...config, consumption: parseFloat(e.target.value) || 1 })}
            style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "2px solid #000", background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000", boxSizing: "border-box" }}
          />

          <label style={{ display: "block", marginBottom: 4, fontWeight: 600, color: "#ccc" }}>Tipo de combustível</label>
          <select
            value={config.fuelType}
            onChange={(e) => setConfig({ ...config, fuelType: e.target.value })}
            style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "2px solid #000", background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000", boxSizing: "border-box" }}
          >
            <option>Gasoline</option>
            <option>Diesel</option>
            <option>Ethanol</option>
            <option>Electric</option>
          </select>

          <label style={{ display: "block", marginBottom: 4, fontWeight: 600, color: "#ccc" }}>Preço do combustível</label>
          <input
            type="number"
            step="0.01"
            value={config.fuelPrice}
            onChange={(e) => setConfig({ ...config, fuelPrice: parseFloat(e.target.value) || 0 })}
            style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "2px solid #000", background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000", boxSizing: "border-box" }}
          />

          <label style={{ display: "block", marginBottom: 4, fontWeight: 600, color: "#ccc" }}>Moeda</label>
          <input
            value={config.currency}
            onChange={(e) => setConfig({ ...config, currency: e.target.value })}
            style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "2px solid #000", background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000", boxSizing: "border-box" }}
          />

          <label style={{ display: "block", marginBottom: 4, fontWeight: 600, color: "#ccc" }}>Unidade</label>
          <select
            value={config.unit}
            onChange={(e) => setConfig({ ...config, unit: e.target.value })}
            style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "2px solid #000", background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000", boxSizing: "border-box" }}
          >
            <option value="km">KM</option>
            <option value="mi">Miles</option>
          </select>

          <label style={{ display: "block", marginBottom: 4, fontWeight: 600, color: "#ccc" }}>Ganho por entrega</label>
          <input
            type="number"
            step="0.01"
            value={config.perDelivery}
            onChange={(e) => setConfig({ ...config, perDelivery: parseFloat(e.target.value) || 0 })}
            style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "2px solid #000", background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000", boxSizing: "border-box" }}
          />

          <label style={{ display: "block", marginBottom: 4, fontWeight: 600, color: "#ccc" }}>Custos fixos diários</label>
          <input
            type="number"
            step="0.01"
            value={config.fixedCost}
            onChange={(e) => setConfig({ ...config, fixedCost: parseFloat(e.target.value) || 0 })}
            style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "2px solid #000", background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000", boxSizing: "border-box" }}
          />
        </div>

        <div style={{
          background: darkMode ? "#1f2937" : "#ffffff",
          padding: 18,
          borderRadius: 16,
          marginTop: 12,
          color: darkMode ? "#fff" : "#000",
          boxSizing: "border-box"
        }}>
          <p>Distância: {config.unit === "km" ? distanceKm.toFixed(1) + " km" : (distanceKm * 0.621371).toFixed(1) + " mi"}</p>
          <p>Combustível usado: {fuelUsed.toFixed(2)} L</p>
          <p>Custo combustível: {config.currency} {fuelCostCalc.toFixed(2)}</p>
          <p>Entregas concluídas: {concluidas.length}</p>
          <p>Receita estimada: {config.currency} {revenue.toFixed(2)}</p>
          <p>Custos fixos: {config.currency} {config.fixedCost.toFixed(2)}</p>
          <h3 style={{ marginTop: 10, fontWeight: 800, color: profit >= 0 ? "#22c55e" : "#ef4444" }}>
            Lucro líquido: {config.currency} {profit.toFixed(2)}
          </h3>
        </div>
      </div>
    );
  }

  // ========== ESTILOS ==========
  // ========== HEADER COM Z-INDEX ==========
  const header = {
    padding: "0px 18px 0 18px",
    background: darkMode ? "#1f2937" : "#fff",
    position: "relative",
    zIndex: 10
  };
  const panel = { background: darkMode ? "#1f2937" : "#fff", padding: 14, borderRadius: 14, marginBottom: 12 };
  const stat = {
    background: darkMode ? "#374151" : "#f3f4f6",
    borderRadius: 16,
    padding: "12px 4px",
    textAlign: "center" as const,
    display: "flex",
    flexDirection: "column" as const,
    fontWeight: 700,
    gap: 6,
    border: darkMode ? "1px solid #4b5563" : "1px solid #e5e7eb",
    boxShadow: "0 2px 4px rgba(0,0,0,0.05)",
    fontSize: "13px"
  };
  const card = { background: darkMode ? "#1f2937" : "#fff", padding: 18, borderRadius: 16, marginBottom: 18 };
  const cardHighlight = { ...card, border: "3px solid #22c55e", boxShadow: "0 0 0 3px rgba(34,197,94,0.25)" };
  const app = {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    width: "100%",
    maxWidth: "100vw",
    overflow: "hidden",
    fontFamily: "Inter, Arial",
    background: "#f3f4f6",
    boxSizing: "border-box"
  };
  // ========== LISTA CORRIGIDA (scroll normal) ==========
  const list = {
    flex: 1,
    overflowY: "auto",
    overflowX: "hidden",
    padding: "18px 12px",
    paddingBottom: "140px",
    boxSizing: "border-box",
    WebkitOverflowScrolling: "touch"
  };
  const offlineBar = { background: "#dc2626", color: "#fff", padding: 8, textAlign: "center", fontWeight: 700, marginBottom: 12 };
  const progressBar = { height: 10, background: "#e5e7eb", borderRadius: 8, marginTop: 6 };
  const progressFill = { height: "100%", background: "#22c55e", borderRadius: 8 };
  const statsBox = {
    display: "grid",
    gridTemplateColumns: "repeat(5, 1fr)",
    gap: 6,
    marginBottom: 12,
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box"
  };
  const grid2 = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 };
  const grid3 = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 };
  const btn = (bg: string, color = "#fff") => ({
    background: bg,
    color,
    height: 52,
    width: "100%",
    border: "2px solid #000",
    borderRadius: 14,
    fontWeight: 700,
    fontSize: 15,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    padding: "0 8px"
  });
  const mini = (bg: string) => ({
    background: bg,
    color: "#fff",
    height: 44,
    width: "100%",
    borderRadius: 12,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: 12,
    border: "2px solid #000",
    textDecoration: "none",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    lineHeight: 1,
    padding: "0 2px"
  });
  const overlay = {
    position: "fixed" as const,
    inset: 0,
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10000
  };

  // ========== COMPONENTE REUTILIZÁVEL DO PAINEL DA PRÓXIMA ENTREGA ==========
  function NextDeliveryPanel() {
    if (!proxima) {
      return (
        <div style={panel}>
          <div><b>Próxima:</b> Nenhuma entrega pendente</div>
          <div>Adicione entregas para iniciar a rota</div>
          <div style={progressBar}>
            <div style={{ ...progressFill, width: "0%" }} />
          </div>
          <div>0 de {all.length} concluídas</div>
        </div>
      );
    }

    return (
      <div style={panel}>
        <div><b>Próxima:</b> {proxima.name || "Destinatário"}</div>
        <div>{[proxima.street, proxima.city].filter(Boolean).join(" — ")}</div>
        
        {distancia !== null ? (
          <div>📍 {distancia.toFixed(1)} km • ⏱️ {eta} min</div>
        ) : (
          <div style={{ opacity: 0.7 }}>
            📍 Localização da entrega não disponível
          </div>
        )}

        {arrived && proxima.status === "nao_realizada" && (
          <button
            style={btn("#16a34a")}
            onClick={() => concluir(proxima.id)}
          >
            ✔ CHEGUEI — CONCLUIR ENTREGA
          </button>
        )}
        <div style={progressBar}>
          <div
            style={{
              ...progressFill,
              width: `${(concluidas.length / (all.length || 1)) * 100}%`
            }}
          />
        </div>
        <div>
          {concluidas.length} de {all.length} concluídas
        </div>
      </div>
    );
  }

  // ========== COMPONENTE DE IMPORTAÇÃO (PÁGINA) ==========
  function ImportScreen() {
    const navigate = useNavigate();
    const [importText, setImportText] = useState("");
    const [importFile, setImportFile] = useState<File | null>(null);

    function handleFileImport(e: React.ChangeEvent<HTMLInputElement>) {
      const file = e.target.files?.[0];
      if (!file) return;
      setImportFile(file);
      const reader = new FileReader();
      reader.onload = () => setImportText(String(reader.result || ""));
      reader.readAsText(file);
    }

    async function importarLista() {
      if (!user || !importText.trim()) return;
      const linhas = importText.split("\n").map(l => l.trim()).filter(Boolean);
      for (const linha of linhas) {
        let phoneMatch = linha.match(/(\+?\d{10,13})/);
        let phone = phoneMatch ? phoneMatch[1] : undefined;
        let texto = phone ? linha.replace(phone, "").trim() : linha;
        const partes = texto.split(/[-;,]/).map(p => p.trim()).filter(Boolean);
        const name = partes[0] || "Destinatário";
        const street = partes.slice(1).join(" ") || texto;
        try {
          const geo = httpsCallable(functions, "geocodeAddress");
          const g: any = await geo({ street });
          await addDoc(collection(db, "deliveries"), {
            userId: user.uid, name, street, phone,
            latitude: g.data.latitude || null,
            longitude: g.data.longitude || null,
            status: "nao_realizada",
            createdAt: Timestamp.now()
          });
        } catch (err) {
          console.error("Erro ao importar linha:", err);
        }
      }
      navigate("/");
    }

    return (
      <div style={{ ...app, background: darkMode ? "#111827" : "#f3f4f6", color: darkMode ? "#fff" : "#000", padding: 20 }}>
        <button style={btn("#374151")} onClick={() => navigate("/")}>
          ← Voltar
        </button>
        <h3 style={{ marginTop: 16, marginBottom: 12 }}>📥 Importar entregas</h3>
        <input type="file" accept=".txt,.csv" onChange={handleFileImport} style={{ marginBottom: 12 }} />
        <textarea
          style={{
            width: "100%",
            height: 180,
            borderRadius: 10,
            padding: 10,
            background: darkMode ? "#374151" : "#fff",
            color: darkMode ? "#fff" : "#000",
            border: "1px solid #ccc",
            boxSizing: "border-box",
            marginBottom: 12
          }}
          value={importText}
          onChange={e => setImportText(e.target.value)}
          placeholder="Cole ou importe um arquivo"
        />
        <button style={btn("#16a34a")} onClick={importarLista}>Importar</button>
        <button style={{ ...btn("#6b7280"), marginTop: 8 }} onClick={() => navigate("/")}>Cancelar</button>
      </div>
    );
  }

  // ========== COMPONENTES DAS TELAS ==========
  const HomeScreen = () => {
    const navigate = useNavigate();
    const baseLista = routeList || pendentes;
    const lista = mode === "proxima" ? pendentes.slice(0, 1) : mode === "historico" ? concluidas : baseLista;

    // Estado para preview dentro do scanner
    const [scannerData, setScannerData] = useState<any>(null);

    const handleScannerCapture = (d: any) => {
      const normalized = {
        name: d?.name || "Destinatário",
        street: d?.street || "",
        district: d?.district || "",
        city: d?.city || "",
        state: d?.state || "",
        postalCode: d?.postalCode || "",
        country: d?.country || "Brasil",
        phone: d?.phone || ""
      };
      setScannerData(normalized);
    };

    const handleSaveFromScanner = async () => {
      if (scannerData) {
        await save(scannerData);
        setIsScannerOpen(false);
        setScannerData(null);
      }
    };

    return (
      <div style={{ ...app, background: darkMode ? "#111827" : "#f3f4f6", color: darkMode ? "#fff" : "#000", position: "relative" }}>
        <div style={header}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <img
              src="/LogiFlow-Pro.png"
              alt="LogiFlow"
              style={{
                height: "clamp(32px, 6vw, 48px)",
                width: "auto",
                maxWidth: "60%",
                objectFit: "contain",
                display: "block",
                marginTop: 6
              }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button style={{ background: "#16a34a", color: "#fff", border: "2px solid #000", borderRadius: 10, padding: "6px 10px", fontWeight: 700 }} onClick={() => setScreen("financeiro")}>💰</button>
              <button style={{ background: darkMode ? "#22c55e" : "#1e3a8a", color: "#fff", border: "2px solid #000", borderRadius: 10, padding: "6px 10px", fontWeight: 700 }} onClick={() => setDarkMode(!darkMode)}>{darkMode ? "🌞" : "🌙"}</button>
            </div>
          </div>
        </div>

        {offline && <div style={offlineBar}>⚠️ Sem internet — modo offline</div>}

        <NextDeliveryPanel />
        <TrialBanner user={user} />

        <div style={statsBox}>
          <div style={stat}><b>Total</b><span style={{ fontSize: 16, fontWeight: 700 }}>{all.length}</span></div>
          <div style={stat}><b>Pendentes</b><span style={{ fontSize: 16, fontWeight: 700 }}>{pendentes.length}</span></div>
          <div style={stat}><b>Concluídas</b><span style={{ fontSize: 16, fontWeight: 700 }}>{concluidas.length}</span></div>
          <div style={stat}><b>Hoje</b><span style={{ fontSize: 16, fontWeight: 700 }}>{hoje.length}</span></div>
          <div style={stat}><b>Faltam</b><span style={{ fontSize: 16, fontWeight: 700 }}>{faltamHoje.length}</span></div>
        </div>

        {/* ========== BOTÕES SCAN/MENU COM Z-INDEX ========== */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
          marginBottom: 12,
          position: "relative",
          zIndex: 10
        }}>
          <button style={btn("#2563eb")} onClick={() => setIsScannerOpen(true)}>📸 Scan</button>
          <button style={btn("#374151")} onClick={() => setAdminOpen(!adminOpen)}>⚙️ Menu</button>
        </div>

        {adminOpen && (
          <>
            <div style={grid2}>
              <button style={btn("#0ea5e9")} onClick={() => navigate("/import")}>📥 Importar</button>
              <button style={btn("#059669")} onClick={handleVoice}>🎤 Falar</button>
              <button style={btn("#9333ea")} onClick={() => navigate("/historico")}>📊 Histórico</button>
              <button style={btn("#047857")} onClick={handleRoute}>🗺 Rota</button>
            </div>
            <div style={{ marginBottom: 12 }}>
              <button style={btn("#8b5cf6")} onClick={startVoiceDestination}>🎤 Destino</button>
            </div>
            <div style={grid3}>
              <button style={btn("#2563eb")} onClick={() => navigate("/pendentes")}>Pendentes</button>
              <button style={btn("#7c3aed")} onClick={() => navigate("/concluidas")}>Concluídas</button>
              <button style={btn("#4b5563")} onClick={() => signOut(auth)}>🚪 Sair</button>
            </div>
          </>
        )}

        <div style={{ ...list, paddingBottom: "120px", minHeight: 0 }}>
          {lista.map((d, i) => (
            <div key={d.id} style={(routeList && i === 0) ? cardHighlight : card}>
              <strong>{i + 1}. {d.name || "Destinatário"}</strong>
              {formatAddress(d).map((linha, idx) => <div key={idx}>{linha}</div>)}
              {d.phone && <div>📞 {d.phone}</div>}
              <button style={btn("#374151")} onClick={() => setExpanded(expanded === d.id ? null : d.id)}>⚙️ Ações</button>
              {expanded === d.id && (
                <div style={grid2}>
                  {d.phone && <a href={`tel:${d.phone}`} style={mini("#1e293b")}>☎ Ligar</a>}
                  {d.phone && (
                    <button
                      style={mini("#16a34a")}
                      onClick={(e) => {
                        e.stopPropagation();
                        aCaminho(d);
                      }}
                    >
                      💬 WhatsApp
                    </button>
                  )}
                  {d.street && <a href={`https://waze.com/ul?q=${encodeURIComponent(d.street + " " + (d.city || ""))}`} target="_self" style={mini("#0ea5e9")}>🚗 Waze</a>}
                  {d.street && <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.street + " " + (d.city || ""))}`} target="_self" style={mini("#2563eb")}>📍 Google</a>}
                  {d.phone && <button style={mini("#0ea5e9")} onClick={() => aCaminho(d)}>🧭 A CAMINHO</button>}
                  <button style={mini("#f59e0b")} onClick={() => tirarProva(d.id)}>📸 PROVA</button>
                  <button
                    style={mini("#dc2626")}
                    onClick={async (e) => {
                      e.stopPropagation();
                      await apagar(d.id);
                      setExpanded(null);
                    }}
                  >
                    🗑 APAGAR
                  </button>
                  {d.status === "nao_realizada" && (
                    <button
                      style={mini("#16a34a")}
                      onClick={async (e) => {
                        e.stopPropagation();
                        await concluir(d.id);
                        setExpanded(null);
                      }}
                    >
                      ✔ CONCLUIR
                    </button>
                  )}
                  <button style={mini("#2563eb")} onClick={() => { setSignDelivery(d.id); setSignOpen(true); }}>✍️ ASSINATURA</button>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* RODAPÉ FIXO */}
        <div style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          width: "100%",
          maxWidth: "100vw",
          background: darkMode ? "#1f2937" : "#ffffff",
          borderTop: "2px solid #e5e7eb",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "6px 4px",
          paddingBottom: "calc(6px + env(safe-area-inset-bottom))",
          zIndex: 999,
          boxSizing: "border-box"
        }}>
          <div style={{
            display: "flex",
            width: "100%",
            gap: "4px",
            justifyContent: "space-between"
          }}>
            <button style={{ ...mini("#ea580c"), flex: 1, minWidth: 0 }} onClick={startNextDeliveryNavigation}>🚀 Próxima</button>
            <button style={{ ...mini("#7c3aed"), flex: 1, minWidth: 0 }} onClick={voltarAoApp}>📍 Cheguei</button>
            <button style={{ ...mini("#dc2626"), flex: 1, minWidth: 0 }} onClick={() => {
              const ok = confirm("🚨 EMERGÊNCIA — enviar alerta com sua localização?");
              if (!ok) return;

              if (!pos) {
                alert("Localização não disponível");
                return;
              }

              const mapsUrl = `https://www.google.com/maps?q=${pos.lat},${pos.lon}`;
              const msg = `EMERGÊNCIA! Motorista em risco.\nLocalização:\n${mapsUrl}`;

              window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_self");
            }}>🚨 SOS</button>
          </div>
          <div style={{
            fontSize: 12,
            textAlign: "center",
            marginTop: 4,
            opacity: 0.7,
            color: darkMode ? "#fff" : "#000"
          }}>
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); window.open("/help.html", "_blank"); }}
              style={{ color: "inherit", textDecoration: "none", margin: "0 4px" }}
            >Ajuda</a>
            {" • "}
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); window.open("/feedback.html", "_blank"); }}
              style={{ color: "inherit", textDecoration: "none", margin: "0 4px" }}
            >Feedback</a>
            {" • "}
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); window.open("/privacy.html", "_blank"); }}
              style={{ color: "inherit", textDecoration: "none", margin: "0 4px" }}
            >Privacidade</a>
          </div>
        </div>

        {isScannerOpen && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "#000",
              zIndex: 9999,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center"
            }}
          >
            {scannerData ? (
              <div style={{ background: darkMode ? "#1f2937" : "#fff", color: darkMode ? "#fff" : "#000", padding: 26, borderRadius: 18, width: "90%", maxWidth: 420, textAlign: "center" }}>
                <h3>{scannerData.name}</h3>
                <p>{scannerData.street}</p>
                <button style={btn("#16a34a")} onClick={handleSaveFromScanner}>Salvar</button>
                <button style={btn("#6b7280")} onClick={() => setScannerData(null)}>Recapturar</button>
                <button style={btn("#dc2626")} onClick={() => { setIsScannerOpen(false); setScannerData(null); }}>Cancelar</button>
              </div>
            ) : (
              <CameraScanner
                onCapture={handleScannerCapture}
                onClose={() => setIsScannerOpen(false)}
              />
            )}
          </div>
        )}

        {signOpen && <SignatureModal onClose={() => setSignOpen(false)} onSave={async (dataUrl) => { if (!signDelivery) return; await updateDoc(doc(db, "deliveries", signDelivery), { signatureImage: dataUrl }); setSignOpen(false); }} darkMode={darkMode} />}
      </div>
    );
  };

  // ========== PENDENTESSCREEN ==========
  const PendentesScreen = () => {
    const navigate = useNavigate();
    const lista = pendentes;
    const [selected, setSelected] = useState<string[]>([]);

    async function apagarSelecionadas() {
      for (const id of selected) {
        await apagar(id);
      }
      setSelected([]);
    }

    return (
      <div style={{ ...app, background: darkMode ? "#111827" : "#f3f4f6", color: darkMode ? "#fff" : "#000" }}>
        <div style={header}>
          <img
            src="/LogiFlow-Pro.png"
            alt="LogiFlow"
            style={{
              height: "clamp(32px, 6vw, 48px)",
              width: "auto",
              maxWidth: "60%",
              objectFit: "contain",
              display: "block",
              marginTop: 6
            }}
          />
        </div>

        <NextDeliveryPanel />

        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr 1fr",
          gap: 10,
          padding: "0 12px",
          marginBottom: 12
        }}>
          <button style={btn("#374151")} onClick={() => navigate("/")}>
            ← Voltar
          </button>

          <button style={btn("#047857")} onClick={handleRoute}>
            🗺️ Rota
          </button>

          <button style={btn(autoMode ? "#16a34a" : "#60a5fa")} onClick={() => setAutoMode(!autoMode)}>
            🔁 Auto
          </button>

          <button style={btn("#dc2626")} onClick={apagarTodasPendentes}>
            🗑 Apagar Todas
          </button>
        </div>

        {selected.length > 0 && (
          <div style={{ padding: "0 12px", marginBottom: 12 }}>
            <button style={btn("#dc2626")} onClick={apagarSelecionadas}>
              🗑 Apagar Selecionadas ({selected.length})
            </button>
          </div>
        )}

        <div style={{ ...list, paddingBottom: "120px", minHeight: 0 }}>
          {lista.map((d, i) => (
            <div key={d.id} style={card}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={selected.includes(d.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => {
                    setSelected(prev => {
                      if (prev.includes(d.id)) {
                        return prev.filter(id => id !== d.id);
                      }
                      return [...prev, d.id];
                    });
                  }}
                />
                <strong>{i + 1}. {d.name || "Destinatário"}</strong>
              </div>
              {formatAddress(d).map((linha, idx) => (
                <div key={idx} style={{ marginLeft: 28 }}>{linha}</div>
              ))}
              {d.phone && <div style={{ marginLeft: 28 }}>📞 {d.phone}</div>}

              <button style={btn("#374151")} onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
                ⚙️ Ações
              </button>

              {expanded === d.id && (
                <div style={grid2}>
                  {d.phone && <a href={`tel:${d.phone}`} style={mini("#1e293b")}>☎ Ligar</a>}
                  {d.phone && (
                    <button
                      style={mini("#16a34a")}
                      onClick={(e) => {
                        e.stopPropagation();
                        aCaminho(d);
                      }}
                    >
                      💬 WhatsApp
                    </button>
                  )}
                  {d.street && <a href={`https://waze.com/ul?q=${encodeURIComponent(d.street + " " + (d.city || ""))}`} target="_self" style={mini("#0ea5e9")}>🚗 Waze</a>}
                  {d.street && <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.street + " " + (d.city || ""))}`} target="_self" style={mini("#2563eb")}>📍 Google</a>}
                  {d.phone && <button style={mini("#0ea5e9")} onClick={() => aCaminho(d)}>🧭 A CAMINHO</button>}
                  <button style={mini("#f59e0b")} onClick={() => tirarProva(d.id)}>📸 PROVA</button>
                  <button
                    style={mini("#dc2626")}
                    onClick={async (e) => {
                      e.stopPropagation();
                      await apagar(d.id);
                      setExpanded(null);
                    }}
                  >
                    🗑 APAGAR
                  </button>
                  {d.status === "nao_realizada" && (
                    <button
                      style={mini("#16a34a")}
                      onClick={async (e) => {
                        e.stopPropagation();
                        await concluir(d.id);
                        setExpanded(null);
                      }}
                    >
                      ✔ CONCLUIR
                    </button>
                  )}
                  <button style={mini("#2563eb")} onClick={() => { setSignDelivery(d.id); setSignOpen(true); }}>✍️ ASSINATURA</button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          width: "100%",
          maxWidth: "100vw",
          background: darkMode ? "#1f2937" : "#ffffff",
          borderTop: "2px solid #e5e7eb",
          display: "flex",
          padding: "6px 4px",
          paddingBottom: "calc(6px + env(safe-area-inset-bottom))",
          gap: "4px",
          zIndex: 999,
          boxSizing: "border-box",
          overflow: "hidden"
        }}>
          <button style={{ ...mini("#ea580c"), flex: 1, minWidth: 0 }} onClick={startNextDeliveryNavigation}>
            🚀 Próxima
          </button>
          <button style={{ ...mini("#7c3aed"), flex: 1, minWidth: 0 }} onClick={voltarAoApp}>
            📍 Cheguei
          </button>
          <button style={{ ...mini("#dc2626"), flex: 1, minWidth: 0 }} onClick={() => {
            const ok = confirm("🚨 EMERGÊNCIA — enviar alerta com sua localização?");
            if (!ok) return;

            if (!pos) {
              alert("Localização não disponível");
              return;
            }

            const mapsUrl = `https://www.google.com/maps?q=${pos.lat},${pos.lon}`;
            const msg = `EMERGÊNCIA! Motorista em risco.\nLocalização:\n${mapsUrl}`;

            window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_self");
          }}>
            🚨 SOS
          </button>
        </div>
      </div>
    );
  };

  // ========== CONCLUIDASSCREEN ==========
  const ConcluidasScreen = () => {
    const navigate = useNavigate();
    const lista = concluidas;

    return (
      <div style={{ ...app, background: darkMode ? "#111827" : "#f3f4f6", color: darkMode ? "#fff" : "#000" }}>
        <div style={header}>
          <img
            src="/LogiFlow-Pro.png"
            alt="LogiFlow"
            style={{
              height: "clamp(32px, 6vw, 48px)",
              width: "auto",
              maxWidth: "60%",
              objectFit: "contain",
              display: "block",
              marginTop: 6
            }}
          />
        </div>

        <NextDeliveryPanel />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, padding: "0 12px", marginBottom: 12 }}>
          <button style={btn("#374151")} onClick={() => navigate("/")}>
            ← Voltar
          </button>
          <button style={btn("#dc2626")} onClick={apagarTodasConcluidas}>
            🗑 Limpar Histórico
          </button>
        </div>

        <div style={{ ...list, paddingBottom: "120px", minHeight: 0 }}>
          {lista.map((d, i) => (
            <div key={d.id} style={card}>
              <strong>{i + 1}. {d.name || "Destinatário"}</strong>
              {formatAddress(d).map((linha, idx) => <div key={idx}>{linha}</div>)}
              {d.phone && <div>📞 {d.phone}</div>}
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ========== HISTORICOSCREEN ==========
  const HistoricoScreen = () => {
    const navigate = useNavigate();
    const lista = concluidas;
    const [selected, setSelected] = useState<string[]>([]);

    async function apagarSelecionadas() {
      for (const id of selected) {
        await apagar(id);
      }
      setSelected([]);
    }

    return (
      <div style={{ ...app, background: darkMode ? "#111827" : "#f3f4f6", color: darkMode ? "#fff" : "#000" }}>
        <div style={header}>
          <img
            src="/LogiFlow-Pro.png"
            alt="LogiFlow"
            style={{
              height: "clamp(32px, 6vw, 48px)",
              width: "auto",
              maxWidth: "60%",
              objectFit: "contain",
              display: "block",
              marginTop: 6
            }}
          />
        </div>

        <NextDeliveryPanel />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, padding: "0 12px", marginBottom: 12 }}>
          <button style={btn("#374151")} onClick={() => navigate("/")}>
            ← Voltar
          </button>
          <button style={btn("#dc2626")} onClick={apagarTodasConcluidas}>
            🗑 Limpar Histórico
          </button>
        </div>

        {selected.length > 0 && (
          <div style={{ padding: "0 12px", marginBottom: 12 }}>
            <button style={btn("#dc2626")} onClick={apagarSelecionadas}>
              🗑 Apagar Selecionadas ({selected.length})
            </button>
          </div>
        )}

        <div style={{ ...list, paddingBottom: "120px", minHeight: 0 }}>
          {lista.map((d, i) => (
            <div key={d.id} style={card}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={selected.includes(d.id)}
                  onChange={() => {
                    setSelected(prev =>
                      prev.includes(d.id)
                        ? prev.filter(id => id !== d.id)
                        : [...prev, d.id]
                    );
                  }}
                />
                <strong>{i + 1}. {d.name || "Destinatário"}</strong>
              </div>
              {formatAddress(d).map((linha, idx) => (
                <div key={idx} style={{ marginLeft: 28 }}>{linha}</div>
              ))}
              {d.phone && <div style={{ marginLeft: 28 }}>📞 {d.phone}</div>}
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ========== COMPONENTE DE ASSINATURA ==========
  function SignatureModal({ onClose, onSave, darkMode }: { onClose: () => void; onSave: (data: string) => void; darkMode: boolean }) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const drawing = useRef(false);

    function start(e: any) {
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d")!;
      ctx.beginPath();
      drawing.current = true;
      draw(e);
    }

    function end() { drawing.current = false; }

    function draw(e: any) {
      if (!drawing.current) return;
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      const ctx = canvas.getContext("2d")!;
      let x, y;
      if (e.touches) {
        x = e.touches[0].clientX - rect.left;
        y = e.touches[0].clientY - rect.top;
      } else {
        x = e.clientX - rect.left;
        y = e.clientY - rect.top;
      }
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#000";
      ctx.lineCap = "round";
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y);
    }

    function clear() { canvasRef.current!.getContext("2d")!.clearRect(0, 0, canvasRef.current!.width, canvasRef.current!.height); }
    function save() { onSave(canvasRef.current!.toDataURL("image/png")); }

    return (
      <div style={overlay}>
        <div style={{ background: darkMode ? "#1f2937" : "#fff", color: darkMode ? "#fff" : "#000", padding: 26, borderRadius: 18, width: "90%", maxWidth: 420, textAlign: "center" }}>
          <h3>Assinatura do Recebedor</h3>
          <canvas
            ref={canvasRef}
            width={320}
            height={200}
            style={{ border: "2px solid #000", borderRadius: 8, touchAction: "none", background: "#fff" }}
            onMouseDown={start}
            onMouseMove={draw}
            onMouseUp={end}
            onMouseLeave={end}
            onTouchStart={start}
            onTouchMove={draw}
            onTouchEnd={end}
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
            <button style={btn("#6b7280")} onClick={clear}>Limpar</button>
            <button style={btn("#16a34a")} onClick={save}>Salvar</button>
          </div>
          <button style={btn("#dc2626")} onClick={onClose}>Cancelar</button>
        </div>
      </div>
    );
  }

  // ========== ROTEAMENTO ==========
  return (
    <Routes>
      <Route path="/" element={<HomeScreen />} />
      <Route path="/import" element={<ImportScreen />} />
      <Route path="/pendentes" element={<PendentesScreen />} />
      <Route path="/concluidas" element={<ConcluidasScreen />} />
      <Route path="/historico" element={<HistoricoScreen />} />
    </Routes>
  );
}