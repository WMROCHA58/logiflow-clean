import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { auth } from './firebase';
import Login from './Login';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { collection, addDoc, query, where, Timestamp, updateDoc, doc, deleteDoc, onSnapshot, setDoc } from 'firebase/firestore';
import { db, functions } from './firebase';
import { httpsCallable } from 'firebase/functions';
import { CameraScanner } from './components/CameraScanner';
import { VoiceEngine } from './voice/voiceEngine';
import { initUserContext } from './modules/userContext';

type DeliveryStatus = "concluida" | "nao_realizada";
type RecipientType = "person" | "company" | null;

interface Delivery {
  id: string;
  createdAt?: any;
  name?: string;
  company?: string;
  recipientType?: RecipientType;
  street?: string;
  district?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
  latitude?: number | null;
  longitude?: number | null;
  status: DeliveryStatus;
}

type GpsStatus = "idle" | "locating" | "ready" | "denied" | "error";

const geocodeCache: Map<string, { lat: number; lon: number } | null> = new Map();

function cleanStreet(street: string, district?: string): string {
  if (!street) return "";
  let cleaned = street.trim().replace(/\s+/g, ' ');
  if (district) {
    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const districtEscaped = escapeRegex(district.trim());
    const patterns = [
      new RegExp(`^${districtEscaped}[,\\s]*`, 'i'),
      new RegExp(`[,\\s]*${districtEscaped}$`, 'i')
    ];
    for (const pattern of patterns) {
      if (pattern.test(cleaned)) {
        cleaned = cleaned.replace(pattern, '').trim().replace(/\s+/g, ' ');
        break;
      }
    }
    cleaned = cleaned.replace(/^[,\s-]+|[,\s-]+$/g, '');
  }
  return cleaned;
}

function getFullAddress(d: Delivery): string {
  return [d.street, d.district, d.city, d.state, d.postalCode, d.country]
    .filter(Boolean).join(", ");
}

function formatAddressLines(d: Delivery) {
  const streetRaw = d.street?.trim() || "";
  const district = d.district?.trim();
  const city = d.city?.trim();
  const state = d.state?.trim();
  const postalCode = d.postalCode?.trim();
  const country = d.country?.trim();

  const street = cleanStreet(streetRaw, district);
  const cityState = city && state ? `${city} — ${state}` : city || state || "";

  const lines = [];
  if (street) lines.push(street);
  if (district && cityState) lines.push(`${district} — ${cityState}`);
  else if (district) lines.push(district);
  else if (cityState) lines.push(cityState);
  if (postalCode && country) lines.push(`${postalCode} — ${country}`);
  else if (postalCode) lines.push(postalCode);
  else if (country) lines.push(country);
  return lines;
}

function calcDistance(aLat: number, aLon: number, bLat: number, bLon: number) {
  const R = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLon = (bLon - aLon) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function hasUsableCoords(d: Delivery): boolean {
  if (d.latitude == null || d.longitude == null) return false;
  const lat = Number(d.latitude);
  const lng = Number(d.longitude);
  return (
    !isNaN(lat) && !isNaN(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180
  );
}

function getDisplayName(d: Delivery | null): string {
  if (!d) return "Destinatário";
  if (d.name && d.name.trim() !== "") {
    return d.name.trim();
  }
  if (d.company && d.company.trim() !== "") {
    return d.company.trim();
  }
  if (d.street) {
    const firstPart = d.street.split(',')[0].trim();
    if (firstPart.length > 2 && !/^\d+$/.test(firstPart)) {
      return firstPart;
    }
  }
  return "Destinatário";
}

async function geocodeAddress(
  street?: string,
  district?: string,
  city?: string,
  state?: string,
  postalCode?: string,
  country?: string
): Promise<{ lat: number; lon: number } | null> {
  const parts = [street, district, city, state, postalCode, country].filter(Boolean);
  const fullAddress = parts.join(", ");
  if (!fullAddress) return null;

  if (geocodeCache.has(fullAddress)) {
    const cached = geocodeCache.get(fullAddress);
    console.log(`[geocodeAddress] cache hit for "${fullAddress.substring(0, 30)}..."`);
    return cached;
  }

  const start = Date.now();
  try {
    const geocode = httpsCallable(functions, "geocodeAddress");
    const payload = {
      street: street || "",
      district: district || "",
      city: city || "",
      state: state || "",
      postalCode: postalCode || "",
      country: country || ""
    };
    const result = await geocode(payload);
    const data = result.data as { latitude?: number; longitude?: number };
    const coords = (data.latitude != null && data.longitude != null)
      ? { lat: data.latitude, lon: data.longitude }
      : null;
    console.log(`[geocodeAddress] ${fullAddress.substring(0, 30)}... -> ${coords ? `(${coords.lat},${coords.lon})` : 'falha'} (${Date.now() - start}ms)`);
    geocodeCache.set(fullAddress, coords);
    return coords;
  } catch (err) {
    console.warn(`[geocodeAddress] erro para "${fullAddress.substring(0, 30)}...":`, err);
    geocodeCache.set(fullAddress, null);
    return null;
  }
}

async function ensureDeliveryCoords(
  lista: Delivery[],
  forceRefresh: boolean = false
): Promise<Delivery[]> {
  const promises = lista.map(async (d) => {
    if (!forceRefresh && hasUsableCoords(d)) return d;
    const coords = await geocodeAddress(
      d.street,
      d.district,
      d.city,
      d.state,
      d.postalCode,
      d.country
    );
    if (coords) {
      console.log(`[ensureDeliveryCoords] Geocodificado em memória: ${d.id} (${d.name || d.company || '?'}) -> (${coords.lat}, ${coords.lon})`);
      return { ...d, latitude: coords.lat, longitude: coords.lon };
    } else {
      console.log(`[ensureDeliveryCoords] Falha ao geocodificar: ${d.id} (${d.name || d.company || '?'})`);
      return { ...d, latitude: null, longitude: null };
    }
  });
  return Promise.all(promises);
}

async function buildRouteOrder(
  baseList: Delivery[],
  startPos: { lat: number; lon: number } | null
): Promise<{
  sorted: Delivery[];
  orderedIds: string[];
  firstLegDistanceMeters: number | null;
  firstLegDurationSeconds: number | null;
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  segments: any[];
}> {
  console.log("[buildRouteOrder] startPos (original):", startPos);
  console.log("[route debug] original order:", baseList.map(d => d.id).join(', '));

  const withCoords = baseList.filter(hasUsableCoords);
  const withoutCoords = baseList.filter(d => !hasUsableCoords(d));

  console.log(`[buildRouteOrder] Com coordenadas: ${withCoords.length}, Sem coordenadas: ${withoutCoords.length}`);
  console.log("[route debug] geocoded order:", withCoords.map(d => d.id).join(', '));
  console.log("[route debug] without coords:", withoutCoords.map(d => d.id).join(', '));

  if (withCoords.length === 0) {
    console.log("[buildRouteOrder] Nenhuma entrega com coordenadas, retornando ordem original");
    console.log("[route debug] fallback reason: no coordinates");
    console.log("[route debug] final order:", baseList.map(d => d.id).join(', '));
    if (baseList.length > 0) {
      console.log(`[route debug] first stop id=${baseList[0].id}`);
      console.log(`[route debug] first stop address="${getFullAddress(baseList[0])}"`);
    }
    return {
      sorted: baseList,
      orderedIds: baseList.map(d => d.id),
      firstLegDistanceMeters: null,
      firstLegDurationSeconds: null,
      totalDistanceMeters: 0,
      totalDurationSeconds: 0,
      segments: []
    };
  }

  if (!startPos) {
    console.log("[buildRouteOrder] startPos ausente, retornando ordem original");
    console.log("[route debug] fallback reason: missing real startPos");
    console.log("[route debug] final order:", baseList.map(d => d.id).join(', '));
    if (baseList.length > 0) {
      console.log(`[route debug] first stop id=${baseList[0].id}`);
      console.log(`[route debug] first stop address="${getFullAddress(baseList[0])}"`);
    }
    return {
      sorted: baseList,
      orderedIds: baseList.map(d => d.id),
      firstLegDistanceMeters: null,
      firstLegDurationSeconds: null,
      totalDistanceMeters: 0,
      totalDurationSeconds: 0,
      segments: []
    };
  }

  console.log("[buildRouteOrder] usando startPos real:", startPos);

  try {
    const optimizeRoute = httpsCallable(functions, "optimizeRoute");
    const payload = {
      startPos,
      deliveries: withCoords.map(d => ({
        id: d.id,
        latitude: d.latitude,
        longitude: d.longitude
      }))
    };
    console.log("[buildRouteOrder] Enviando para optimizeRoute:", JSON.stringify(payload, null, 2));

    const result = await optimizeRoute(payload);
    const data = result.data as {
      orderedIds: string[];
      orderedValidIds: string[];
      invalidIdsAtEnd: string[];
      orderedDeliveries: any[];
      firstLegDistanceMeters: number | null;
      firstLegDurationSeconds: number | null;
      totalDistanceMeters: number;
      totalDurationSeconds: number;
      segments: any[];
    };

    console.log("[ROUTE AUTH] orderedIds raw:", data.orderedIds);
    console.log("[buildRouteOrder] Resposta da optimizeRoute:", data);

    if (!data.orderedIds || !Array.isArray(data.orderedIds)) {
      console.warn("[buildRouteOrder] orderedIds inválido, mantendo ordem original");
      console.log("[route debug] fallback reason: invalid orderedIds");
      return {
        sorted: baseList,
        orderedIds: baseList.map(d => d.id),
        firstLegDistanceMeters: null,
        firstLegDurationSeconds: null,
        totalDistanceMeters: 0,
        totalDurationSeconds: 0,
        segments: []
      };
    }

    // orderedIds deve ter o mesmo tamanho que withCoords
    if (data.orderedIds.length !== withCoords.length) {
      console.warn(`[buildRouteOrder] orderedIds length (${data.orderedIds.length}) != withCoords (${withCoords.length}), mantendo ordem original`);
      console.log("[route debug] fallback reason: orderedIds length mismatch");
      return {
        sorted: baseList,
        orderedIds: baseList.map(d => d.id),
        firstLegDistanceMeters: null,
        firstLegDurationSeconds: null,
        totalDistanceMeters: 0,
        totalDurationSeconds: 0,
        segments: []
      };
    }

    const deliveryMap = new Map(withCoords.map(d => [d.id, d]));
    const orderedWithCoords: Delivery[] = [];
    for (const id of data.orderedIds) {
      const d = deliveryMap.get(id);
      if (!d) {
        console.warn(`[buildRouteOrder] id ${id} não encontrado nos withCoords, abortando`);
        console.log("[route debug] fallback reason: missing id in orderedIds");
        return {
          sorted: baseList,
          orderedIds: baseList.map(d => d.id),
          firstLegDistanceMeters: null,
          firstLegDurationSeconds: null,
          totalDistanceMeters: 0,
          totalDurationSeconds: 0,
          segments: []
        };
      }
      orderedWithCoords.push(d);
    }

    const finalOrder = orderedWithCoords.concat(withoutCoords);
    console.log("[route debug] final order (otimizada):", finalOrder.map(d => d.id).join(' → '));
    if (finalOrder.length > 0) {
      console.log(`[route debug] first stop id=${finalOrder[0].id}`);
      console.log(`[route debug] first stop address="${getFullAddress(finalOrder[0])}"`);
    }

    return {
      sorted: finalOrder,
      orderedIds: data.orderedIds,
      firstLegDistanceMeters: data.firstLegDistanceMeters,
      firstLegDurationSeconds: data.firstLegDurationSeconds,
      totalDistanceMeters: data.totalDistanceMeters,
      totalDurationSeconds: data.totalDurationSeconds,
      segments: data.segments,
    };
  } catch (err) {
    console.warn("[buildRouteOrder] Erro ao chamar optimizeRoute, mantendo ordem original", err);
    console.log("[route debug] fallback reason: optimizeRoute error");
    console.log("[route debug] final order:", baseList.map(d => d.id).join(', '));
    if (baseList.length > 0) {
      console.log(`[route debug] first stop id=${baseList[0].id}`);
      console.log(`[route debug] first stop address="${getFullAddress(baseList[0])}"`);
    }
    return {
      sorted: baseList,
      orderedIds: baseList.map(d => d.id),
      firstLegDistanceMeters: null,
      firstLegDurationSeconds: null,
      totalDistanceMeters: 0,
      totalDurationSeconds: 0,
      segments: []
    };
  }
}

async function computeFirstLeg(
  route: Delivery[] | null,
  pos: { lat: number; lon: number } | null
): Promise<{ id: string; dist: number; eta: number } | null> {
  if (!route?.length || !pos) return null;
  const first = route[0];
  if (!hasUsableCoords(first)) return null;

  try {
    const getDistanceMatrix = httpsCallable(functions, "getDistanceMatrix");
    const points = [
      { lat: pos.lat, lng: pos.lon },
      { lat: first.latitude!, lng: first.longitude! }
    ];
    const result = await getDistanceMatrix({ points });
    const matrix = result.data as { distances?: number[][]; durations?: number[][] };

    if (!matrix || !matrix.distances || !matrix.durations) return null;
    if (matrix.distances.length === 0 || matrix.durations.length === 0) return null;

    const distancesRow = matrix.distances[0];
    const durationsRow = matrix.durations[0];

    if (!Array.isArray(distancesRow) || !Array.isArray(durationsRow)) return null;
    if (distancesRow.length !== durationsRow.length) return null;

    // Para 2 pontos (origem + destino), a distância está na coluna 1
    // Se a matriz for 2x2, acessamos index 1
    const idx = distancesRow.length > 1 ? 1 : 0;
    const distMeters = distancesRow[idx];
    const durationSecs = durationsRow[idx];

    if (distMeters === undefined || durationSecs === undefined) return null;

    const distKm = distMeters / 1000;
    const etaMin = Math.round(durationSecs / 60);
    if (distKm < 0 || distKm > 1000 || etaMin < 0 || etaMin > 1000) return null;

    console.log(`[TOP ETA] Primeira perna: ${first.id}, dist=${distKm} km, eta=${etaMin} min`);
    return { id: first.id, dist: distKm, eta: etaMin };
  } catch (err) {
    console.warn("[computeFirstLeg] erro na matriz", err);
  }
  return null;
}

const i18n = {
  pt: {
    loading: "Carregando...", checking: "Verificando assinatura...", subRequired: "Assinatura necessária",
    trialExpired: "Seu período de teste expirou ou não há assinatura ativa.", subscribe: "Assinar agora",
    trialExpiredBanner: "⛔ Seu teste gratuito expirou — assine para continuar",
    trialLast: "⚠️ Últimos {d} dia(s) do teste gratuito", trialDays: "🧪 Teste gratuito — {d} dia(s) restantes",
    next: "Próxima:", noPending: "Nenhuma entrega pendente", addDeliveries: "Adicione entregas para iniciar a rota",
    zeroOf: "0 de {t} concluídas", distTime: "📍 {d} km • ⏱️ {e} min", locUnavail: "📍 Localização não disponível",
    arrivedBtn: "✔ CHEGUEI — CONCLUIR ENTREGA", completedOf: "{c} de {t} concluídas",
    scan: "📸 Scan", menu: "⚙️ Menu", import: "📥 Importar", speak: "🎤 Falar", routeActive: "🗺 Rota ativa", route: "🗺 Rota",
    history: "📊 Histórico", voiceDest: "🎤 Destino", pending: "Pendentes", completed: "Concluídas", logout: "🚪 Sair",
    call: "☎ Ligar", whatsapp: "💬 WhatsApp", waze: "🚗 Waze", google: "📍 Google", enRoute: "🧭 A CAMINHO",
    proof: "📸 PROVA", delete: "🗑 APAGAR", complete: "✔ CONCLUIR", signature: "✍️ ASSINATURA",
    help: "Ajuda", feedback: "Feedback", privacy: "Privacidade", nextBtn: "🚀 Próxima", arrivedBtn2: "📍 Cheguei",
    sosBtn: "🚨 SOS", sosConfirm: "🚨 EMERGÊNCIA — enviar alerta com sua localização?", locAlert: "Localização não disponível",
    importTitle: "📥 Importar entregas", importPlaceholder: "Cole ou importe um arquivo", importButton: "Importar",
    cancel: "Cancelar", deleteAllPending: "🗑 Apagar Todas", auto: "🔁 Auto", deleteSelected: "🗑 Apagar Selecionadas ({c})",
    clearHistory: "🗑 Limpar Histórico", signTitle: "Assinatura do Recebedor", clear: "Limpar", save: "Salvar",
    backToOps: "← Voltar para operação", financeTitle: "💰 Finanças do Dia", vehicleConfig: "⚙️ Configuração do veículo",
    vehicleType: "Tipo de veículo", consumption: "Consumo (km por litro)", fuelType: "Tipo de combustível",
    fuelPrice: "Preço do combustível", currency: "Moeda", unit: "Unidade", perDelivery: "Ganho por entrega",
    fixedCosts: "Custos fixos diários", distance: "Distância", fuelUsed: "Combustível usado", fuelCost: "Custo combustível",
    deliveriesCompleted: "Entregas concluídas", estimatedRevenue: "Receita estimada", netProfit: "Lucro líquido",
    offline: "⚠️ Sem internet — modo offline", total: "Total", pendingStat: "Pendentes", completedStat: "Concluídas",
    today: "Hoje", remaining: "Faltam", actions: "⚙️ Ações", recapture: "Recapturar",
    back: "← Voltar", select: "Selecionar", selected: "✓",
    emergencyContactLabel: "📞 Contato de emergência (WhatsApp)",
    sosMessage: "EMERGÊNCIA! Motorista em risco.\nLocalização:\nhttps://www.google.com/maps?q={lat},{lon}",
    noEmergencyContact: "Configure um contato de emergência em Finanças > Contato de emergência.",
    invalidAddress: "Endereço inválido",
    loginFirst: "Faça login primeiro",
    speechNotSupported: "Seu navegador não suporta reconhecimento de voz",
    voiceError: "Erro: {error}",
    addressNotFound: "Endereço não identificado pelo scanner.",
    organizingRoute: "Organizando rota...",
    gpsSearching: "📡 Obtendo sua localização...",
    gpsReady: "📍 GPS ativo",
    gpsDenied: "⛔ Permissão de localização negada",
    gpsError: "⚠️ Erro ao obter localização",
    gpsUnavailable: "GPS não disponível neste aparelho",
    gpsRequired: "Ative a localização e aguarde o GPS antes de organizar a rota.",
    gpsCoords: "Origem: {lat}, {lon}"
  },
  en: {
    loading: "Loading...", checking: "Checking subscription...", subRequired: "Subscription required",
    trialExpired: "Your trial period has expired or no active subscription.", subscribe: "Subscribe now",
    trialExpiredBanner: "⛔ Your free trial has expired — subscribe to continue",
    trialLast: "⚠️ Last {d} day(s) of free trial", trialDays: "🧪 Free trial — {d} day(s) left",
    next: "Next:", noPending: "No pending deliveries", addDeliveries: "Add deliveries to start route",
    zeroOf: "0 of {t} completed", distTime: "📍 {d} km • ⏱️ {e} min", locUnavail: "📍 Location not available",
    arrivedBtn: "✔ ARRIVED — COMPLETE DELIVERY", completedOf: "{c} of {t} completed",
    scan: "📸 Scan", menu: "⚙️ Menu", import: "📥 Import", speak: "🎤 Speak", routeActive: "🗺 Route active", route: "🗺 Route",
    history: "📊 History", voiceDest: "🎤 Destination", pending: "Pending", completed: "Completed", logout: "🚪 Logout",
    call: "☎ Call", whatsapp: "💬 WhatsApp", waze: "🚗 Waze", google: "📍 Google", enRoute: "🧭 EN ROUTE",
    proof: "📸 PROOF", delete: "🗑 DELETE", complete: "✔ COMPLETE", signature: "✍️ SIGNATURE",
    help: "Help", feedback: "Feedback", privacy: "Privacy", nextBtn: "🚀 Next", arrivedBtn2: "📍 Arrived",
    sosBtn: "🚨 SOS", sosConfirm: "🚨 EMERGENCY — send alert with your location?", locAlert: "Location not available",
    importTitle: "📥 Import deliveries", importPlaceholder: "Paste or import a file", importButton: "Import",
    cancel: "Cancel", deleteAllPending: "🗑 Delete All", auto: "🔁 Auto", deleteSelected: "🗑 Delete Selected ({c})",
    clearHistory: "🗑 Clear History", signTitle: "Recipient's Signature", clear: "Clear", save: "Save",
    backToOps: "← Back to operation", financeTitle: "💰 Daily Finances", vehicleConfig: "⚙️ Vehicle configuration",
    vehicleType: "Vehicle type", consumption: "Consumption (km per liter)", fuelType: "Fuel type",
    fuelPrice: "Fuel price", currency: "Currency", unit: "Unit", perDelivery: "Earnings per delivery",
    fixedCosts: "Daily fixed costs", distance: "Distance", fuelUsed: "Fuel used", fuelCost: "Fuel cost",
    deliveriesCompleted: "Deliveries completed", estimatedRevenue: "Estimated revenue", netProfit: "Net profit",
    offline: "⚠️ No internet — offline mode", total: "Total", pendingStat: "Pending", completedStat: "Completed",
    today: "Today", remaining: "Remaining", actions: "⚙️ Actions", recapture: "Recapture",
    back: "← Back", select: "Select", selected: "✓",
    emergencyContactLabel: "📞 Emergency contact (WhatsApp)",
    sosMessage: "EMERGENCY! Driver at risk.\nLocation:\nhttps://www.google.com/maps?q={lat},{lon}",
    noEmergencyContact: "Set an emergency contact in Finances > Emergency contact.",
    invalidAddress: "Invalid address",
    loginFirst: "Please log in first",
    speechNotSupported: "Your browser does not support speech recognition",
    voiceError: "Error: {error}",
    addressNotFound: "Address not identified by scanner.",
    organizingRoute: "Organizing route...",
    gpsSearching: "📡 Getting your location...",
    gpsReady: "📍 GPS active",
    gpsDenied: "⛔ Location permission denied",
    gpsError: "⚠️ Error getting location",
    gpsUnavailable: "GPS is not available on this device",
    gpsRequired: "Enable location and wait for GPS before organizing the route.",
    gpsCoords: "Start point: {lat}, {lon}"
  },
  es: {
    loading: "Cargando...", checking: "Verificando suscripción...", subRequired: "Suscripción requerida",
    trialExpired: "Su período de prueba ha expirado o no hay suscripción activa.", subscribe: "Suscríbase ahora",
    trialExpiredBanner: "⛔ Su prueba gratuita ha expirado — suscríbase para continuar",
    trialLast: "⚠️ Últimos {d} día(s) de prueba gratuita", trialDays: "🧪 Prueba gratuita — {d} día(s) restantes",
    next: "Siguiente:", noPending: "No hay entregas pendientes", addDeliveries: "Agregue entregas para iniciar la ruta",
    zeroOf: "0 de {t} completadas", distTime: "📍 {d} km • ⏱️ {e} min", locUnavail: "📍 Ubicación no disponible",
    arrivedBtn: "✔ LLEGUÉ — COMPLETAR ENTREGA", completedOf: "{c} de {t} completadas",
    scan: "📸 Escanear", menu: "⚙️ Menú", import: "📥 Importar", speak: "🎤 Hablar", routeActive: "🗺 Ruta activa", route: "🗺 Ruta",
    history: "📊 Historial", voiceDest: "🎤 Destino", pending: "Pendientes", completed: "Completadas", logout: "🚪 Salir",
    call: "☎ Llamar", whatsapp: "💬 WhatsApp", waze: "🚗 Waze", google: "📍 Google", enRoute: "🧭 EN RUTA",
    proof: "📸 PRUEBA", delete: "🗑 ELIMINAR", complete: "✔ COMPLETAR", signature: "✍️ FIRMA",
    help: "Ayuda", feedback: "Comentarios", privacy: "Privacidad", nextBtn: "🚀 Siguiente", arrivedBtn2: "📍 Llegué",
    sosBtn: "🚨 SOS", sosConfirm: "🚨 EMERGENCIA — ¿enviar alerta con su ubicación?", locAlert: "Ubicación no disponible",
    importTitle: "📥 Importar entregas", importPlaceholder: "Pegue o importe un archivo", importButton: "Importar",
    cancel: "Cancelar", deleteAllPending: "🗑 Eliminar todas", auto: "🔁 Auto", deleteSelected: "🗑 Eliminar seleccionadas ({c})",
    clearHistory: "🗑 Limpiar historial", signTitle: "Firma del receptor", clear: "Limpiar", save: "Guardar",
    backToOps: "← Volver a operación", financeTitle: "💰 Finanzas del Día", vehicleConfig: "⚙️ Configuración del vehículo",
    vehicleType: "Tipo de vehículo", consumption: "Consumo (km por litro)", fuelType: "Tipo de combustible",
    fuelPrice: "Precio del combustible", currency: "Moneda", unit: "Unidad", perDelivery: "Ganancia por entrega",
    fixedCosts: "Costos fijos diarios", distance: "Distancia", fuelUsed: "Combustible usado", fuelCost: "Costo combustible",
    deliveriesCompleted: "Entregas completadas", estimatedRevenue: "Ingreso estimado", netProfit: "Ganancia neta",
    offline: "⚠️ Sin internet — modo offline", total: "Total", pendingStat: "Pendientes", completedStat: "Completadas",
    today: "Hoje", remaining: "Faltan", actions: "⚙️ Acciones", recapture: "Recapturar",
    back: "← Volver", select: "Seleccionar", selected: "✓",
    emergencyContactLabel: "📞 Contacto de emergencia (WhatsApp)",
    sosMessage: "¡EMERGENCIA! Conductor en riesgo.\nUbicación:\nhttps://www.google.com/maps?q={lat},{lon}",
    noEmergencyContact: "Configure un contacto de emergencia en Finanzas > Contacto de emergencia.",
    invalidAddress: "Dirección inválida",
    loginFirst: "Inicie sesión primero",
    speechNotSupported: "Su navegador no soporta reconocimiento de voz",
    voiceError: "Error: {error}",
    addressNotFound: "Dirección no identificada por el escáner.",
    organizingRoute: "Organizando ruta...",
    gpsSearching: "📡 Obteniendo su ubicación...",
    gpsReady: "📍 GPS activo",
    gpsDenied: "⛔ Permiso de ubicación negado",
    gpsError: "⚠️ Error al obtener ubicación",
    gpsUnavailable: "GPS no disponible en este dispositivo",
    gpsRequired: "Active la ubicación y espere al GPS antes de organizar la ruta.",
    gpsCoords: "Origen: {lat}, {lon}"
  }
};
type TranslationKey = keyof typeof i18n.pt;

interface GpsStatusBannerProps {
  darkMode: boolean;
  title: string;
  subtitle?: string;
  status: GpsStatus;
}
function GpsStatusBanner({ darkMode, title, subtitle, status }: GpsStatusBannerProps) {
  const getBgColor = () => {
    if (status === "ready") return darkMode ? "#065f46" : "#d1fae5";
    if (status === "locating") return darkMode ? "#92400e" : "#fef3c7";
    if (status === "denied" || status === "error") return darkMode ? "#991b1b" : "#fee2e2";
    return darkMode ? "#1f2937" : "#f3f4f6";
  };
  const getTextColor = () => {
    if (status === "ready") return darkMode ? "#d1fae5" : "#065f46";
    if (status === "locating") return darkMode ? "#fef3c7" : "#92400e";
    if (status === "denied" || status === "error") return darkMode ? "#fee2e2" : "#991b1b";
    return darkMode ? "#fff" : "#000";
  };
  return (
    <div style={{
      padding: "8px 12px",
      margin: "0 12px 12px 12px",
      borderRadius: 12,
      background: getBgColor(),
      color: getTextColor(),
      fontWeight: 500,
      fontSize: 14,
      display: "flex",
      flexDirection: "column" as const,
      border: darkMode ? "1px solid #374151" : "1px solid #e5e7eb"
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span>{title}</span>
      </div>
      {subtitle && <div style={{ fontSize: 12, opacity: 0.9, marginTop: 4 }}>{subtitle}</div>}
    </div>
  );
}

interface NextDeliveryPanelProps {
  darkMode: boolean;
  t: (key: string, params?: any) => string;
  proxima: Delivery | null;
  distancia: number | null;
  eta: number | null;
  arrived: boolean;
  onComplete: (id: string) => void;
  concluidasCount: number;
  totalCount: number;
}
function NextDeliveryPanel({ darkMode, t, proxima, distancia, eta, arrived, onComplete, concluidasCount, totalCount }: NextDeliveryPanelProps) {
  const panel = {
    background: darkMode ? "#1f2937" : "#fff",
    padding: 14,
    borderRadius: 14,
    marginBottom: 12
  } as const;
  const cleanedStreet = proxima ? cleanStreet(proxima.street || "", proxima.district) : "";
  const topAddressLine = proxima ? [cleanedStreet, proxima.city].filter(Boolean).join(" — ") : "";
  const nomeExibido = getDisplayName(proxima);
  if (!proxima) return (
    <div style={panel}>
      <div><b>{t('next')}</b> {t('noPending')}</div>
      <div>{t('addDeliveries')}</div>
      <div style={{ height: 10, background: "#e5e7eb", borderRadius: 8, marginTop: 6 }}><div style={{ height: "100%", background: "#22c55e", borderRadius: 8, width: "0%" }} /></div>
      <div>{t('zeroOf', { t: totalCount })}</div>
    </div>
  );
  return (
    <div style={panel}>
      <div><b>{t('next')}</b> {nomeExibido}</div>
      <div>{topAddressLine}</div>
      {distancia !== null ? <div>{t('distTime', { d: distancia.toFixed(1), e: eta })}</div> : <div style={{ opacity: 0.7 }}>{t('locUnavail')}</div>}
      {arrived && proxima.status === "nao_realizada" && <button style={btnStyle("#16a34a", darkMode)} onClick={() => onComplete(proxima.id)}>{t('arrivedBtn')}</button>}
      <div style={{ height: 10, background: "#e5e7eb", borderRadius: 8, marginTop: 6 }}><div style={{ height: "100%", background: "#22c55e", borderRadius: 8, width: `${(concluidasCount / (totalCount || 1)) * 100}%` }} /></div>
      <div>{t('completedOf', { c: concluidasCount, t: totalCount })}</div>
    </div>
  );
}

function btnStyle(bg: string, darkMode: boolean) {
  return {
    background: bg,
    color: "#fff",
    height: 52,
    width: "100%",
    border: "2px solid #000",
    borderRadius: 14,
    fontWeight: 700,
    fontSize: 15,
    display: "flex" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    boxSizing: "border-box" as const,
    padding: "0 8px"
  };
}
function miniStyle(bg: string) {
  return {
    background: bg,
    color: "#fff",
    height: 44,
    width: "100%",
    borderRadius: 12,
    display: "flex" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    fontWeight: 700,
    fontSize: 12,
    border: "2px solid #000",
    textDecoration: "none" as const,
    whiteSpace: "nowrap" as const,
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
    lineHeight: 1,
    padding: "0 2px"
  };
}

interface PendentesScreenProps {
  darkMode: boolean;
  activeList: Delivery[];
  all: Delivery[];
  rotaAtiva: boolean;
  autoMode: boolean;
  setAutoMode: React.Dispatch<React.SetStateAction<boolean>>;
  pos: { lat: number; lon: number } | null;
  t: (key: string, params?: any) => string;
  onCompleteDelivery: (id: string) => Promise<void>;
  onDeleteDelivery: (id: string) => Promise<void>;
  apagarTodasPendentes: () => Promise<void>;
  aCaminho: (d: Delivery) => void;
  tirarProva: (id: string) => void;
  setSignDelivery: React.Dispatch<React.SetStateAction<string | null>>;
  setSignOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handleRoute: () => void;
  isRouteLoading: boolean;
  nextDelivery: Delivery | null;
  nextDistance: number | null;
  nextEta: number | null;
  nextArrived: boolean;
  onNextDeliveryNavigation: () => void;
  onArrivedCurrentDelivery: () => Promise<void>;
  emergencyContact: string;
  onSOS: () => void;
  gpsStatus: GpsStatus;
  gpsTitle: string;
  gpsSubtitle?: string;
  routeMessage: string;
  showEmergencyPanel: boolean;
  setShowEmergencyPanel: React.Dispatch<React.SetStateAction<boolean>>;
  emergencyContactInputRef: React.RefObject<HTMLInputElement | null>;
  onSaveEmergencyContact: (contact: string) => void;
  deliveryNumbersById: Record<string, number>;
}
function PendentesScreen(props: PendentesScreenProps) {
  const navigate = useNavigate();
  const {
    darkMode, activeList, all, rotaAtiva, autoMode, setAutoMode, pos, t,
    onCompleteDelivery, onDeleteDelivery, apagarTodasPendentes,
    aCaminho, tirarProva, setSignDelivery, setSignOpen, handleRoute, isRouteLoading,
    nextDelivery, nextDistance, nextEta, nextArrived,
    onNextDeliveryNavigation, onArrivedCurrentDelivery, onSOS,
    gpsStatus, gpsTitle, gpsSubtitle, routeMessage,
    showEmergencyPanel, setShowEmergencyPanel, emergencyContactInputRef, onSaveEmergencyContact,
    deliveryNumbersById
  } = props;

  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [emergencyInputValue, setEmergencyInputValue] = useState(props.emergencyContact || "");

  useEffect(() => {
    if (showEmergencyPanel) {
      setEmergencyInputValue(props.emergencyContact || "");
    }
  }, [showEmergencyPanel, props.emergencyContact]);

  const displayedList = activeList.filter(item => !deletedIds.has(item.id));
  const concluidasCount = all.filter(d => d.status === "concluida").length;
  const totalCount = all.length;

  if (displayedList.length > 0) console.log('[PENDENTES AUTH] ids:', displayedList.map(d => d.id).join(', '));
  if (displayedList.length > 0) console.log('[PENDENTES RENDER] first item id:', displayedList[0].id);

  const handleDeleteSingle = async (e: React.MouseEvent, d: Delivery) => {
    e.stopPropagation();
    setExpanded(null);
    setSelected(prev => prev.filter(id => id !== d.id));
    setDeletedIds(prev => new Set([...prev, d.id]));
    await onDeleteDelivery(d.id);
  };
  const handleCompleteSingle = async (e: React.MouseEvent, d: Delivery) => {
    e.stopPropagation();
    setExpanded(null);
    setSelected(prev => prev.filter(id => id !== d.id));
    await onCompleteDelivery(d.id);
  };
  const handleDeleteSelected = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setDeletedIds(prev => new Set([...prev, ...ids]));
    setSelected([]);
    setExpanded(null);
    for (const id of ids) await onDeleteDelivery(id);
  };
  const handleDeleteAll = async () => {
    const ids = displayedList.map(d => d.id);
    if (!ids.length) return;
    setDeletedIds(prev => new Set([...prev, ...ids]));
    setSelected([]);
    setExpanded(null);
    await apagarTodasPendentes();
  };

  const app = {
    display: "flex" as const, flexDirection: "column" as const, height: "100vh", width: "100%",
    maxWidth: "100vw", overflow: "hidden" as const, fontFamily: "Inter, Arial", background: "#f3f4f6", boxSizing: "border-box" as const
  };
  const header = { padding: "18px 18px", background: darkMode ? "#1f2937" : "#fff", position: "relative" as const, zIndex: 10 } as const;
  const card = { background: darkMode ? "#1f2937" : "#fff", padding: 18, borderRadius: 16, marginBottom: 18 } as const;
  const cardHighlight = { ...card, border: "3px solid #22c55e", boxShadow: "0 0 0 3px rgba(34,197,94,0.25)" } as const;
  const list = { flex: 1, overflowY: "auto" as const, overflowX: "hidden" as const, padding: "18px 12px", paddingBottom: "140px", boxSizing: "border-box" as const, WebkitOverflowScrolling: "touch" as const } as const;

  return (
    <div style={{ ...app, background: darkMode ? "#111827" : "#f3f4f6", color: darkMode ? "#fff" : "#000" }}>
      <div style={header}>
        <img src="/LogiFlow-Pro.png" alt="LogiFlow" style={{ height: "clamp(40px,7vw,60px)", width: "auto", maxWidth: "60%", objectFit: "contain", display: "block", marginTop: 6 }} />
      </div>
      <GpsStatusBanner darkMode={darkMode} title={gpsTitle} subtitle={gpsSubtitle} status={gpsStatus} />
      {routeMessage && (
        <div style={{
          padding: "8px 12px",
          margin: "0 12px 12px 12px",
          borderRadius: 12,
          background: darkMode ? "#1e3a8a" : "#dbeafe",
          color: darkMode ? "#dbeafe" : "#1e3a8a",
          fontWeight: 500,
          fontSize: 14,
          border: darkMode ? "1px solid #2563eb" : "1px solid #93c5fd"
        }}>
          {routeMessage}
        </div>
      )}
      <NextDeliveryPanel
        darkMode={darkMode} t={t} proxima={nextDelivery} distancia={nextDistance} eta={nextEta}
        arrived={nextArrived} onComplete={onCompleteDelivery} concluidasCount={concluidasCount} totalCount={totalCount}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, padding: "0 12px", marginBottom: 12 }}>
        <button style={btnStyle("#374151", darkMode)} onClick={() => navigate("/")}>{t('back')}</button>
        <button
          style={btnStyle(rotaAtiva ? "#16a34a" : "#047857", darkMode)}
          onClick={handleRoute}
          disabled={isRouteLoading}
        >
          {isRouteLoading ? t('organizingRoute') : (rotaAtiva ? t('routeActive') : t('route'))}
        </button>
        <button style={btnStyle(autoMode ? "#16a34a" : "#60a5fa", darkMode)} onClick={() => setAutoMode(!autoMode)}>{t('auto')}</button>
        <button style={btnStyle("#dc2626", darkMode)} onClick={handleDeleteAll}>{t('deleteAllPending')}</button>
      </div>
      {selected.length > 0 && (
        <div style={{ padding: "0 12px", marginBottom: 12 }}>
          <button style={btnStyle("#dc2626", darkMode)} onClick={handleDeleteSelected}>{t('deleteSelected', { c: selected.length })}</button>
        </div>
      )}
      <div style={{ ...list, paddingBottom: "120px", minHeight: 0 }}>
        {displayedList.map((d, i) => {
          const shouldHighlight = nextDelivery?.id === d.id;
          const nomeExibido = getDisplayName(d);
          return (
            <div key={d.id} style={shouldHighlight ? cardHighlight : card}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(prev => prev.includes(d.id) ? prev.filter(id => id !== d.id) : [...prev, d.id]);
                  }}
                  style={{
                    width: 32, height: 32, borderRadius: 8, border: "2px solid #000",
                    background: selected.includes(d.id) ? "#22c55e" : darkMode ? "#374151" : "#fff",
                    color: selected.includes(d.id) ? "#fff" : darkMode ? "#fff" : "#000",
                    fontWeight: 700, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer"
                  }}
                >{selected.includes(d.id) ? t('selected') : ""}</button>
                <strong>{deliveryNumbersById[d.id] ?? i + 1}. {nomeExibido}</strong>
                {rotaAtiva && (
                  <span style={{
                    background: "#16a34a",
                    color: "#fff",
                    padding: "2px 6px",
                    borderRadius: 4,
                    fontSize: 12,
                    fontWeight: 700,
                    marginLeft: 8
                  }}>ROTA</span>
                )}
              </div>
              {formatAddressLines(d).map((linha, idx) => <div key={idx} style={{ marginLeft: 40 }}>{linha}</div>)}
              {d.phone && <div style={{ marginLeft: 40 }}>📞 {d.phone}</div>}
              <button style={btnStyle("#374151", darkMode)} onClick={() => setExpanded(expanded === d.id ? null : d.id)}>{t('actions')}</button>
              {expanded === d.id && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {d.phone && <a href={`tel:${d.phone}`} style={miniStyle("#1e293b")}>{t('call')}</a>}
                  {d.phone && <button style={miniStyle("#16a34a")} onClick={e => { e.stopPropagation(); aCaminho(d); }}>{t('whatsapp')}</button>}
                  {d.street && <a href={`https://waze.com/ul?q=${encodeURIComponent(getFullAddress(d))}`} target="_self" style={miniStyle("#0ea5e9")}>{t('waze')}</a>}
                  {d.street && <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(getFullAddress(d))}`} target="_self" style={miniStyle("#2563eb")}>{t('google')}</a>}
                  {d.phone && <button style={miniStyle("#0ea5e9")} onClick={() => aCaminho(d)}>{t('enRoute')}</button>}
                  <button style={miniStyle("#f59e0b")} onClick={() => tirarProva(d.id)}>{t('proof')}</button>
                  <button style={miniStyle("#dc2626")} onClick={(e) => handleDeleteSingle(e, d)}>{t('delete')}</button>
                  {d.status === "nao_realizada" && <button style={miniStyle("#16a34a")} onClick={(e) => handleCompleteSingle(e, d)}>{t('complete')}</button>}
                  <button style={miniStyle("#2563eb")} onClick={() => { setSignDelivery(d.id); setSignOpen(true); }}>{t('signature')}</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {showEmergencyPanel && (
        <div
          style={{
            position: "fixed",
            left: 12,
            right: 12,
            bottom: 68,
            zIndex: 1000,
            background: darkMode ? "#1f2937" : "#ffffff",
            color: darkMode ? "#fff" : "#000",
            border: "2px solid #000",
            borderRadius: 14,
            padding: 12,
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)"
          }}
        >
          <label style={{ display: "block", marginBottom: 8, fontWeight: 700 }}>
            {t('emergencyContactLabel')}
          </label>

          <input
            ref={emergencyContactInputRef}
            type="text"
            value={emergencyInputValue}
            onChange={(e) => setEmergencyInputValue(e.target.value)}
            placeholder="+5511999999999"
            style={{
              width: "100%",
              height: 44,
              borderRadius: 10,
              border: "2px solid #000",
              padding: "0 12px",
              boxSizing: "border-box",
              marginBottom: 10,
              background: darkMode ? "#374151" : "#fff",
              color: darkMode ? "#fff" : "#000"
            }}
          />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button
              style={btnStyle("#16a34a", darkMode)}
              onClick={() => {
                const contact = emergencyInputValue.trim();
                onSaveEmergencyContact(contact);
                setShowEmergencyPanel(false);
              }}
            >
              {t('save')}
            </button>

            <button
              style={btnStyle("#6b7280", darkMode)}
              onClick={() => {
                setEmergencyInputValue(props.emergencyContact || "");
                setShowEmergencyPanel(false);
              }}
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      )}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, width: "100%", maxWidth: "100vw", background: darkMode ? "#1f2937" : "#ffffff", borderTop: "2px solid #e5e7eb", display: "flex", padding: "6px 4px", paddingBottom: "calc(6px + env(safe-area-inset-bottom))", gap: "4px", zIndex: 999, boxSizing: "border-box", overflow: "hidden" }}>
        <button style={{ ...miniStyle("#ea580c"), flex: 1 }} onClick={onNextDeliveryNavigation}>{t('nextBtn')}</button>
        <button style={{ ...miniStyle("#7c3aed"), flex: 1 }} onClick={onArrivedCurrentDelivery}>{t('arrivedBtn2')}</button>
        <button style={{ ...miniStyle("#dc2626"), flex: 1 }} onClick={onSOS}>{t('sosBtn')}</button>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<any>(null);
  const ADMIN_EMAIL = "williamwmr52@gmail.com";
  const isAdmin = user?.email === ADMIN_EMAIL;
  const [all, setAll] = useState<Delivery[]>([]);
  const [plannedRoute, setPlannedRoute] = useState<Delivery[] | null>(null);
  const [routeOrderIds, setRouteOrderIds] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [offline, setOffline] = useState(typeof navigator !== "undefined" ? !navigator.onLine : false);
  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(null);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("idle");
  const [adminOpen, setAdminOpen] = useState(false);
  const [autoMode, setAutoMode] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const [signDelivery, setSignDelivery] = useState<string | null>(null);
  const [distanceKm, setDistanceKm] = useState(0);
  const [, setFuelCost] = useState(0);
  const [screen, setScreen] = useState<"operacao" | "financeiro">("operacao");
  const [routeMessage, setRouteMessage] = useState<string>("");
  const [isProcessingScan, setIsProcessingScan] = useState(false);
  const [isSavingScan, setIsSavingScan] = useState(false);
  const [scannerData, setScannerData] = useState<any>(null);
  const scannerCaptureLockRef = useRef(false);
  const [routeTopSummary, setRouteTopSummary] = useState<{ deliveryId: string; distanceKm: number; etaMin: number } | null>(null);
  const [showEmergencyPanel, setShowEmergencyPanel] = useState(false);
  const emergencyContactInputRef = useRef<HTMLInputElement | null>(null);
  const [deliveryNumbersById, setDeliveryNumbersById] = useState<Record<string, number>>({});
  const deliveryNumberCounterRef = useRef(1);
  const previousActiveListIdsRef = useRef<string[]>([]);
  const numberingBaseRef = useRef<string | null>(null);
  const homeListScrollTopRef = useRef(0);
  const concluidasListScrollTopRef = useRef(0);

  const defaultConfig = {
    vehicleType: "Moto", consumption: 30, fuelType: "Gasoline", fuelPrice: 6.0,
    currency: "R$", unit: "km", perDelivery: 8.0, fixedCost: 0, emergencyContact: ""
  };
  const [config, setConfig] = useState(() => {
    const saved = localStorage.getItem("lf_financial_config");
    if (saved) { try { return { ...defaultConfig, ...JSON.parse(saved) }; } catch { } }
    return defaultConfig;
  });
  const [subscriptionStatus, setSubscriptionStatus] = useState<string | null>(null);
  const [checkingSubscription, setCheckingSubscription] = useState(true);
  const [rotaAtiva, setRotaAtiva] = useState(false);
  const [isRouteLoading, setIsRouteLoading] = useState(false);
  const lastPosRef = useRef<{ lat: number; lon: number } | null>(null);
  const voiceRef = useRef<VoiceEngine | null>(null);
  const isCalculatingRouteRef = useRef(false);
  const pendingRecalcRef = useRef(false);
  const posRef = useRef<{ lat: number; lon: number } | null>(null);
  const [firstLeg, setFirstLeg] = useState<{ id: string; dist: number; eta: number } | null>(null);
  const [routeStartPos, setRouteStartPos] = useState<{ lat: number; lon: number } | null>(null);

  // ===================== VARIÁVEIS PARA INVALIDAÇÃO DE ROTA =====================
  // Assinatura estável da lista atual de pendentes (ids ordenados)
  const [routeBaseSignature, setRouteBaseSignature] = useState<string | null>(null);
  const stablePendentes = useMemo(() => {
    return [...all.filter(d => d.status === "nao_realizada")].sort((a, b) => {
      const timeA = a.createdAt?.toDate?.()?.getTime() || 0;
      const timeB = b.createdAt?.toDate?.()?.getTime() || 0;
      if (timeA !== timeB) return timeA - timeB;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
  }, [all]);

  const pendingSignature = useMemo(() => {
    return stablePendentes.map(d => d.id).join(',');
  }, [stablePendentes]);

  // Efeito para invalidar a rota apenas quando a lista atual NÃO for uma subsequência
  // que preserve a ordem da rota original (ou seja, apenas remoções permitidas)
  useEffect(() => {
    if (!rotaAtiva || routeBaseSignature === null) return;

    const baseIds = routeBaseSignature.split(",").filter(Boolean);
    const currentIds = pendingSignature.split(",").filter(Boolean);

    const isSubsequenceKeepingOrder = (sub: string[], full: string[]) => {
      let i = 0;
      let j = 0;
      while (i < sub.length && j < full.length) {
        if (sub[i] === full[j]) i++;
        j++;
      }
      return i === sub.length;
    };

    // Se a lista atual apenas perdeu itens da rota original, mantendo a ordem,
    // NÃO invalidar a rota. Isso cobre exatamente o caso do botão CHEGUEI.
    if (isSubsequenceKeepingOrder(currentIds, baseIds)) {
      return;
    }

    console.log(
      "[ROUTE] invalidated because pending list changed materially (current: %s, route base: %s)",
      pendingSignature,
      routeBaseSignature
    );

    setRotaAtiva(false);
    setRouteOrderIds(null);
    setPlannedRoute(null);
    setFirstLeg(null);
    setRouteTopSummary(null);
    setRouteMessage("");
    setRouteStartPos(null);
    setRouteBaseSignature(null);
  }, [rotaAtiva, routeBaseSignature, pendingSignature]);
  // ===============================================================================

  const [lang] = useState<'pt' | 'en' | 'es'>(() => {
    const browserLang = navigator.language.split('-')[0];
    return browserLang === 'pt' || browserLang === 'en' || browserLang === 'es' ? browserLang : 'pt';
  });
  const t = (key: TranslationKey, p?: Record<string, string | number>) => {
    let txt = i18n[lang][key];
    if (p) Object.keys(p).forEach(k => txt = txt.replace(`{${k}}`, String(p[k])));
    return txt;
  };

  const gpsTitle = useMemo(() => {
    if (gpsStatus === "locating") return t("gpsSearching");
    if (gpsStatus === "ready") return t("gpsReady");
    if (gpsStatus === "denied") return t("gpsDenied");
    if (gpsStatus === "error") return t("gpsError");
    return t("gpsUnavailable");
  }, [gpsStatus, t]);

  const gpsSubtitle = useMemo(() => {
    if (gpsStatus === "ready" && pos) {
      return t("gpsCoords", { lat: pos.lat.toFixed(3), lon: pos.lon.toFixed(3) });
    }
    if (gpsStatus === "denied" || gpsStatus === "error") {
      return t("gpsRequired");
    }
    return undefined;
  }, [gpsStatus, pos, t]);

  useEffect(() => { localStorage.setItem("lf_financial_config", JSON.stringify(config)); }, [config]);

  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsStatus("error");
      return;
    }
    if (isScannerOpen) {
      return;
    }
    setGpsStatus("locating");
    const id = navigator.geolocation.watchPosition(
      p => {
        const coords = { lat: p.coords.latitude, lon: p.coords.longitude };
        setPos(coords);
        posRef.current = coords;
        setGpsStatus("ready");
        if (lastPosRef.current) {
          const d = calcDistance(lastPosRef.current.lat, lastPosRef.current.lon, coords.lat, coords.lon);
          if (d > 0.01) {
            setDistanceKm(prev => {
              const newDist = prev + d;
              setFuelCost(newDist / config.consumption * config.fuelPrice);
              return newDist;
            });
          }
        }
        lastPosRef.current = coords;
      },
      err => {
        console.error("[gps] watchPosition error", err);
        if (err.code === 1) setGpsStatus("denied");
        else setGpsStatus("error");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [config, isScannerOpen]);

  useEffect(() => {
    const on = () => { setOffline(false); syncQueue(); };
    const off = () => setOffline(true);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
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
  }

  useEffect(() => { if (!voiceRef.current) voiceRef.current = new VoiceEngine(); }, []);

  useEffect(() => {
    const u = onAuthStateChanged(auth, async x => {
      if (x) { setUser(x); await initUserContext(x.uid); } else setUser(null);
      setLoading(false);
    });
    return () => u();
  }, []);

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "deliveries"), where("userId", "==", user.uid));
    const unsub = onSnapshot(q, snap => {
      const cleanDeliveries = snap.docs.map(d => {
        const data = d.data();
        const hasCoords = data.latitude != null && data.longitude != null;
        return {
          id: d.id,
          ...data,
          latitude: data.latitude ?? null,
          longitude: data.longitude ?? null,
        } as Delivery;
      });
      console.log(`[snapshot] ${cleanDeliveries.length} deliveries recebidas`);
      console.log('[snapshot] ids:', cleanDeliveries.map(d => d.id).join(', '));
      const withCoordsCount = cleanDeliveries.filter(d => hasUsableCoords(d)).length;
      console.log(`[snapshot] ${withCoordsCount} com coordenadas válidas`);
      setAll(cleanDeliveries);
    });
    return () => unsub();
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const ref = doc(db, "subscriptions", user.uid);
    const unsub = onSnapshot(ref, async snap => {
      if (!snap.exists()) {
        const trialEnd = Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
        await setDoc(ref, { status: "trialing", trialEndsAt: trialEnd, createdAt: Timestamp.now() });
        setSubscriptionStatus("trialing"); setCheckingSubscription(false); return;
      }
      const data = snap.data();
      if (!data) { setSubscriptionStatus("trialing"); setCheckingSubscription(false); return; }
      if (data.status === "trialing" && data.trialEndsAt) {
        setSubscriptionStatus(data.trialEndsAt.seconds < Timestamp.now().seconds ? "expired" : "trialing");
      } else if (data.status === "active") setSubscriptionStatus("active");
      else setSubscriptionStatus("expired");
      setCheckingSubscription(false);
    }, err => { console.error(err); setSubscriptionStatus("expired"); setCheckingSubscription(false); });
    return () => unsub();
  }, [user]);

  const pendentes = useMemo(() => all.filter(d => d.status === "nao_realizada"), [all]);
  const concluidas = useMemo(() => all.filter(d => d.status === "concluida"), [all]);
  const hoje = useMemo(() => {
    const s = new Date(); s.setHours(0, 0, 0, 0); const e = new Date(); e.setHours(23, 59, 59, 999);
    return all.filter(d => { const t = d.createdAt?.toDate?.(); return t && t >= s && t <= e; });
  }, [all]);
  const faltamHoje = hoje.filter(d => d.status === "nao_realizada");

  // ========== orderDeliveriesByRouteIds ==========
  const orderDeliveriesByRouteIds = (deliveries: Delivery[], routeIds: string[] | null): Delivery[] => {
    if (!routeIds || routeIds.length === 0) return deliveries;
    const map = new Map(deliveries.map(d => [d.id, d]));
    const ordered: Delivery[] = [];
    const remaining: Delivery[] = [];
    for (const id of routeIds) {
      const d = map.get(id);
      if (d) ordered.push(d);
    }
    for (const d of deliveries) {
      if (!routeIds.includes(d.id)) remaining.push(d);
    }
    return ordered.concat(remaining);
  };
  // ===============================================

  // Helper para verificar se sub é subsequência de full mantendo ordem
  const isSubsequenceWithOrder = (sub: string[], full: string[]) => {
    let i = 0;
    let j = 0;
    while (i < sub.length && j < full.length) {
      if (sub[i] === full[j]) i++;
      j++;
    }
    return i === sub.length;
  };
  // ===============================================

  // activeList: usa rota se a lista atual for subsequência (apenas remoções) da rota original
  const activeList = useMemo(() => {
    if (rotaAtiva && routeOrderIds && routeBaseSignature) {
      const baseIds = routeBaseSignature.split(',').filter(Boolean);
      const currentIds = pendingSignature.split(',').filter(Boolean);
      if (isSubsequenceWithOrder(currentIds, baseIds)) {
        const ordered = orderDeliveriesByRouteIds(pendentes, routeOrderIds);
        console.log("[ACTIVE LIST] source: routeOrderIds (subsequence-valid route)");
        console.log("[ACTIVE LIST] ids:", ordered.map(d => d.id).join(', '));
        return ordered;
      }
    }
    console.log("[ACTIVE LIST] source: stablePendentes (no valid route)");
    console.log("[ACTIVE LIST] ids:", stablePendentes.map(d => d.id).join(', '));
    return stablePendentes;
  }, [rotaAtiva, routeOrderIds, routeBaseSignature, pendingSignature, pendentes, stablePendentes]);

  // ===================== NUMERAÇÃO PERSISTENTE =====================
  useEffect(() => {
    const currentIds = activeList.map(d => d.id);
    const numberingBaseKey =
      rotaAtiva && routeBaseSignature
        ? `route:${routeBaseSignature}`
        : `plain:${pendingSignature}`;

    setDeliveryNumbersById(prev => {
      if (currentIds.length === 0) {
        previousActiveListIdsRef.current = [];
        deliveryNumberCounterRef.current = 1;
        numberingBaseRef.current = null;
        return {};
      }

      // Só reinicia a numeração quando a base da rota/lista mudou de verdade.
      if (numberingBaseRef.current !== numberingBaseKey) {
        const freshMap: Record<string, number> = {};
        currentIds.forEach((id, idx) => {
          freshMap[id] = idx + 1;
        });
        previousActiveListIdsRef.current = currentIds;
        deliveryNumberCounterRef.current = currentIds.length + 1;
        numberingBaseRef.current = numberingBaseKey;
        return freshMap;
      }

      // Dentro da mesma base, preserva o número já dado a cada entrega.
      let nextCounter = deliveryNumberCounterRef.current;
      const nextMap: Record<string, number> = {};

      for (const id of currentIds) {
        if (prev[id] !== undefined) {
          nextMap[id] = prev[id];
        } else {
          nextMap[id] = nextCounter;
          nextCounter++;
        }
      }

      previousActiveListIdsRef.current = currentIds;
      deliveryNumberCounterRef.current = nextCounter;
      return nextMap;
    });
  }, [activeList, rotaAtiva, routeBaseSignature, pendingSignature]);
  // ================================================================

  // Função para sincronizar plannedRoute com os dados atuais de pendentes e routeOrderIds (não usada quando rota inválida)
  const syncPlannedRouteWithCurrentData = useCallback(() => {
    if (!rotaAtiva || !routeOrderIds) {
      if (plannedRoute !== null) setPlannedRoute(null);
      return;
    }

    const map = new Map(pendentes.map(d => [d.id, d]));
    const newPlanned: Delivery[] = [];

    for (const id of routeOrderIds) {
      const d = map.get(id);
      if (d) newPlanned.push(d);
    }

    setPlannedRoute(newPlanned);
  }, [rotaAtiva, routeOrderIds, pendentes, plannedRoute]);

  const setHomeListNode = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const savedTop = homeListScrollTopRef.current;
    if (Math.abs(node.scrollTop - savedTop) > 1) {
      requestAnimationFrame(() => {
        node.scrollTop = savedTop;
      });
    }
  }, []);

  const setConcluidasListNode = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const savedTop = concluidasListScrollTopRef.current;
    if (Math.abs(node.scrollTop - savedTop) > 1) {
      requestAnimationFrame(() => {
        node.scrollTop = savedTop;
      });
    }
  }, []);

  // Executar sync apenas quando a lista atual é subsequência da rota original (apenas remoções)
  useEffect(() => {
    if (!rotaAtiva || !routeOrderIds || !routeBaseSignature) return;
    const baseIds = routeBaseSignature.split(',').filter(Boolean);
    const currentIds = pendingSignature.split(',').filter(Boolean);
    if (isSubsequenceWithOrder(currentIds, baseIds)) {
      syncPlannedRouteWithCurrentData();
    }
  }, [pendentes, routeOrderIds, syncPlannedRouteWithCurrentData, rotaAtiva, routeBaseSignature, pendingSignature]);

  const nextDelivery = activeList.length > 0 ? activeList[0] : null;
  useEffect(() => {
    console.log('[ROUTE SOURCE] nextDelivery id:', nextDelivery?.id ?? null);
  }, [nextDelivery]);

  const nextDistance = useMemo(() => {
    if (rotaAtiva && routeTopSummary && routeTopSummary.deliveryId === nextDelivery?.id) {
      return routeTopSummary.distanceKm;
    }
    return null;
  }, [nextDelivery, rotaAtiva, routeTopSummary]);

  const nextEta = useMemo(() => {
    if (rotaAtiva && routeTopSummary && routeTopSummary.deliveryId === nextDelivery?.id) {
      return routeTopSummary.etaMin;
    }
    return null;
  }, [nextDelivery, rotaAtiva, routeTopSummary]);

  const nextArrived = nextDistance !== null && nextDistance <= 0.18;

  useEffect(() => { posRef.current = pos; }, [pos]);

  async function recalcRoute(forceRefreshCoords = false, startPos: { lat: number; lon: number }): Promise<{
    sorted: Delivery[] | null;
    routeChanged: boolean;
    validCoordsCount: number;
  }> {
    if (isCalculatingRouteRef.current) {
      pendingRecalcRef.current = true;
      return { sorted: null, routeChanged: false, validCoordsCount: 0 };
    }
    try {
      isCalculatingRouteRef.current = true;
      console.log("[recalcRoute] currentPos (recebido):", startPos);
      if (!pendentes.length) {
        console.log("[recalcRoute] sem pendentes, limpando rota");
        setPlannedRoute(null);
        setRouteOrderIds(null);
        setRotaAtiva(false);
        setFirstLeg(null);
        setRouteTopSummary(null);
        setRouteMessage("");
        return { sorted: null, routeChanged: false, validCoordsCount: 0 };
      }
      const base = await ensureDeliveryCoords(stablePendentes, forceRefreshCoords);
      const validCoordsCount = base.filter(hasUsableCoords).length;
      const invalidCoordsCount = base.length - validCoordsCount;
      console.log(`[recalcRoute] Em memória: ${validCoordsCount} com coordenadas, ${invalidCoordsCount} sem coordenadas.`);
      console.log("[recalcRoute] ordem base ids:", base.map(d => d.id).join(', '));
      const { sorted, orderedIds, firstLegDistanceMeters, firstLegDurationSeconds } = await buildRouteOrder(base, startPos);
      console.log("[recalcRoute] sorted (final) ids:", sorted.map(d => d.id).join(', '));
      console.log("[ROUTE SOURCE] routeOrderIds saved:", orderedIds);
      if (sorted.map(d => d.id).join(',') !== orderedIds.join(',')) {
        console.error("[recalcRoute] divergência grave: sorted ids ≠ orderedIds, reconstruindo...");
        // Reconstruir sorted a partir de orderedIds
        const map = new Map(base.map(d => [d.id, d]));
        const rebuiltSorted: Delivery[] = [];
        for (const id of orderedIds) {
          const d = map.get(id);
          if (d) rebuiltSorted.push(d);
        }
        // Adicionar os que estão em base mas não em orderedIds? Eles devem ir para o final.
        const remaining = base.filter(d => !orderedIds.includes(d.id));
        const finalSorted = rebuiltSorted.concat(remaining);
        const finalIds = finalSorted.map(d => d.id);
        console.log("[recalcRoute] ordem reconstruída:", finalIds.join(', '));
        setPlannedRoute(finalSorted);
        setRouteOrderIds(finalIds);
        const leg = (firstLegDistanceMeters != null && firstLegDurationSeconds != null && finalSorted.length > 0)
          ? { id: finalSorted[0].id, dist: firstLegDistanceMeters / 1000, eta: Math.round(firstLegDurationSeconds / 60) }
          : await computeFirstLeg(finalSorted, startPos);
        setFirstLeg(leg);
        if (leg && finalSorted.length > 0 && finalSorted[0].id === leg.id) {
          setRouteTopSummary({ deliveryId: leg.id, distanceKm: leg.dist, etaMin: leg.eta });
        } else {
          setRouteTopSummary(null);
        }
        return { sorted: finalSorted, routeChanged: true, validCoordsCount };
      }
      const finalSorted = sorted;
      if (finalSorted.length > 0) {
        const first = finalSorted[0];
        console.log(`[route debug] first stop id=${first.id}`);
        console.log(`[route debug] first stop label="${getDisplayName(first)}"`);
        console.log(`[route debug] first stop address="${getFullAddress(first)}"`);
        console.log(`[route debug] first stop coords=(${first.latitude}, ${first.longitude})`);
      }
      console.log("[route debug] ordem final detalhada:");
      finalSorted.forEach((d, idx) => {
        console.log(`[route debug] final #${idx + 1} id=${d.id} label="${getDisplayName(d)}" address="${getFullAddress(d)}"`);
      });
      const baseIds = base.map(d => d.id);
      const sortedIds = sorted.map(d => d.id);
      const routeChanged = baseIds.length === sortedIds.length && baseIds.some((id, idx) => id !== sortedIds[idx]);
      setPlannedRoute(finalSorted);
      setRouteOrderIds(orderedIds);
      let leg = null;
      if (firstLegDistanceMeters != null && firstLegDurationSeconds != null && finalSorted.length > 0) {
        leg = { id: finalSorted[0].id, dist: firstLegDistanceMeters / 1000, eta: Math.round(firstLegDurationSeconds / 60) };
      } else {
        leg = await computeFirstLeg(finalSorted, startPos);
      }
      setFirstLeg(leg);
      if (leg && finalSorted.length > 0 && finalSorted[0].id === leg.id) {
        setRouteTopSummary({ deliveryId: leg.id, distanceKm: leg.dist, etaMin: leg.eta });
      } else {
        setRouteTopSummary(null);
      }
      return { sorted: finalSorted, routeChanged, validCoordsCount };
    } finally {
      isCalculatingRouteRef.current = false;
      if (pendingRecalcRef.current) {
        pendingRecalcRef.current = false;
      }
    }
  }

  function getCurrentPositionForRoute(): Promise<{ lat: number; lon: number }> {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocalização não suportada"));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          console.log("[ROUTE] current GPS from click:", coords);
          resolve(coords);
        },
        (err) => {
          console.error("[ROUTE] erro ao obter GPS no clique:", err);
          reject(err);
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  async function handleRoute() {
    if (isProcessingScan || isSavingScan) {
      console.warn("[handleRoute] scan em andamento, abortando rota");
      alert("Aguarde o processamento do scan antes de organizar a rota.");
      return;
    }
    console.log("[handleRoute] iniciando, rotaAtiva:", rotaAtiva);
    const startTime = Date.now();
    // Se rota está ativa e a lista atual é subsequência da rota original, simplesmente desligar
    if (rotaAtiva && routeBaseSignature) {
      const baseIds = routeBaseSignature.split(',').filter(Boolean);
      const currentIds = pendingSignature.split(',').filter(Boolean);
      if (isSubsequenceWithOrder(currentIds, baseIds)) {
        console.log("[handleRoute] desligando rota (válida)");
        setPlannedRoute(null);
        setRouteOrderIds(null);
        setRotaAtiva(false);
        setFirstLeg(null);
        setRouteTopSummary(null);
        setRouteMessage("");
        setRouteStartPos(null);
        setRouteBaseSignature(null);
        return;
      }
    }
    // Caso contrário (rota desligada ou inválida), recalcular nova rota
    console.log("[handleRoute] calculando nova rota (ativa: %s, subsequence match: %s)", rotaAtiva, rotaAtiva && routeBaseSignature ? isSubsequenceWithOrder(pendingSignature.split(',').filter(Boolean), routeBaseSignature.split(',').filter(Boolean)) : false);
    setIsRouteLoading(true);
    setRouteMessage(t('organizingRoute'));
    try {
      let posUsada: { lat: number; lon: number };
      try {
        posUsada = await getCurrentPositionForRoute();
      } catch (err) {
        console.warn("[handleRoute] falha ao obter GPS, não é possível otimizar rota");
        alert(t("gpsRequired"));
        setRouteMessage("");
        return;
      }
      setRouteStartPos(posUsada);
      const result = await recalcRoute(true, posUsada);
      const { sorted, routeChanged, validCoordsCount } = result;
      console.log("[handleRoute] recalcRoute retornou:", sorted?.map(d => d.id).join(', ') || 'null');
      if (sorted && sorted.length > 0) {
        setRotaAtiva(true);
        // Guardar a assinatura da lista usada para esta rota
        setRouteBaseSignature(pendingSignature);
        if (validCoordsCount === 0) {
          setRouteMessage("Rota ativa, mas sem coordenadas suficientes para reorganizar");
        } else if (routeChanged) {
          setRouteMessage("Rota organizada com sucesso");
        } else {
          setRouteMessage("Rota calculada — ordem atual já é a mais próxima");
        }
      } else {
        console.warn("[handleRoute] recalcRoute não retornou lista válida, rota não ativada");
        setRotaAtiva(false);
        setPlannedRoute(null);
        setRouteOrderIds(null);
        setFirstLeg(null);
        setRouteTopSummary(null);
        setRouteMessage("");
        setRouteStartPos(null);
        setRouteBaseSignature(null);
      }
      console.log(`[handleRoute] tempo total: ${Date.now() - startTime}ms`);
    } finally {
      setIsRouteLoading(false);
    }
  }

  function navigateToDelivery(d: Delivery | null) {
    if (!d) { alert(t('noPending')); return; }
    if (hasUsableCoords(d)) {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${d.latitude},${d.longitude}`, "_self");
    } else {
      const addr = getFullAddress(d);
      if (!addr) { alert(t('invalidAddress')); return; }
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}`, "_self");
    }
  }
  function handleNextDeliveryNavigation() { navigateToDelivery(nextDelivery); }

  async function handleArrivedCurrentDelivery() {
    if (nextDelivery) {
      if (nextDelivery.status === "nao_realizada") await completeDelivery(nextDelivery.id);
    }
  }

  async function completeDelivery(id: string) {
    await updateDoc(doc(db, "deliveries", id), { status: "concluida" });
    setAll(prev => prev.map(item => item.id === id ? { ...item, status: "concluida" } : item));
    // A invalidação da rota será feita automaticamente pelo efeito que monitora pendingSignature.
    console.log("[COMPLETE] delivery completed, route will be invalidated by signature change.");
  }

  async function deleteDelivery(id: string) {
    await apagar(id);
    setAll(prev => prev.filter(item => item.id !== id));
    console.log("[DELETE] delivery deleted, route will be invalidated by signature change.");
  }

  async function apagar(id: string) {
    try { await deleteDoc(doc(db, "deliveries", id)); } catch (err) { console.error(err); }
  }

  async function apagarTodasPendentes() {
    for (const d of pendentes) await deleteDelivery(d.id);
  }

  async function apagarTodasConcluidas() {
    for (const d of concluidas) await deleteDelivery(d.id);
  }

  function aCaminho(d: Delivery) {
    if (!pos || !d.phone) return;
    const mapsLink = `https://www.google.com/maps?q=${pos.lat},${pos.lon}`;
    const endereco = getFullAddress(d);
    const msg = `Olá, estou a caminho da sua entrega.\n\nEndereço:\n${endereco}\n\nLocalização do entregador:\n${mapsLink}`;
    const phone = d.phone.replace(/\D/g, '');
    if (phone) window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, "_blank");
  }

  function handleSOS() {
    if (!confirm(t('sosConfirm'))) return;
    if (!pos) {
      alert(t('locAlert'));
      return;
    }

    const emergency = (config.emergencyContact || "").trim();

    if (!emergency) {
      setShowEmergencyPanel(true);
      setTimeout(() => emergencyContactInputRef.current?.focus(), 0);
      return;
    }

    const clean = emergency.replace(/\D/g, '');
    const message = t('sosMessage', { lat: pos.lat, lon: pos.lon });
    window.open(`https://wa.me/${clean}?text=${encodeURIComponent(message)}`, "_self");
  }

  function handleVoice() {
    try { (voiceRef.current as any)?.abort?.(); } catch { }
    voiceRef.current?.start(async (txt: string) => {
      const lower = txt.toLowerCase();
      if (lower.includes("quantas") || lower.includes("faltam")) {
        voiceRef.current?.speak(`Você tem ${pendentes.length} entregas pendentes`);
      } else if (lower.includes("proxima") || lower.includes("próxima")) {
        if (!nextDelivery) voiceRef.current?.speak("Não há entregas pendentes");
        else voiceRef.current?.speak(`Próxima entrega: ${getDisplayName(nextDelivery)}, ${nextDelivery.street || ""}, ${nextDelivery.city || ""}`);
      } else voiceRef.current?.speak("Comando não reconhecido");
    });
  }

  function startVoiceDestination() {
    if (!user) { alert(t('loginFirst')); return; }
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) { alert(t('speechNotSupported')); return; }
    const recognition = new SpeechRecognition();
    if (lang === 'pt') recognition.lang = 'pt-BR';
    else if (lang === 'en') recognition.lang = 'en-US';
    else if (lang === 'es') recognition.lang = 'es-ES';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.start();
    recognition.onresult = async (event: any) => {
      let text = event.results[0][0].transcript.trim().replace(/\s+/g, ' ');
      await addDoc(collection(db, "deliveries"), {
        userId: user.uid,
        name: "Destino por voz",
        street: text,
        phone: null,
        latitude: null,
        longitude: null,
        status: "nao_realizada",
        createdAt: Timestamp.now()
      });
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(text)}`, "_self");
    };
    recognition.onerror = (e: any) => alert(t('voiceError', { error: e.error }));
  }

  async function tirarProva(id: string) {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/*"; input.capture = "environment";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => await updateDoc(doc(db, "deliveries", id), { proofImage: reader.result });
      reader.readAsDataURL(file);
    };
    input.click();
  }

  async function save(data: any): Promise<boolean> {
    if (!user) return false;
    if (!data.street) { alert(t('addressNotFound')); return false; }
    if (isSavingScan) {
      console.warn("[save] já está salvando, ignorando clique duplicado");
      return false;
    }
    setIsSavingScan(true);
    const nameToSave = data.name?.trim() || "";
    const companyToSave = data.company?.trim() || "";
    console.log("[SCAN SAVE] final recipient label =", nameToSave || companyToSave || "Destinatário");
    const tempId = "temp_" + Date.now() + "_" + Math.random().toString(36).substring(2);
    const tempDelivery: Delivery = {
      id: tempId,
      name: nameToSave,
      company: companyToSave,
      street: data.street,
      district: data.district || "",
      city: data.city || "",
      state: data.state || "",
      postalCode: data.postalCode || "",
      country: data.country || "",
      phone: data.phone || "",
      latitude: null,
      longitude: null,
      status: "nao_realizada",
      createdAt: Timestamp.now()
    };
    setAll(prev => [...prev, tempDelivery]);
    try {
      const docRef = await addDoc(collection(db, "deliveries"), {
        ...data,
        name: nameToSave,
        company: companyToSave,
        userId: user.uid,
        latitude: null,
        longitude: null,
        status: "nao_realizada",
        createdAt: Timestamp.now()
      });
      console.log("[save] documento criado com ID:", docRef.id);
      setAll(prev => prev.map(item => item.id === tempId ? { ...item, id: docRef.id } : item));
      return true;
    } catch (err) {
      console.error("[save] erro ao salvar:", err);
      setAll(prev => prev.filter(item => item.id !== tempId));
      alert("Erro ao salvar entrega. Tente novamente.");
      return false;
    } finally {
      setIsSavingScan(false);
    }
  }

  function TrialBanner({ user }: { user: any }) {
    const [daysLeft, setDaysLeft] = useState<number | null>(null);
    useEffect(() => {
      if (!user) return;
      const ref = doc(db, "subscriptions", user.uid);
      const unsub = onSnapshot(ref, snap => {
        if (!snap.exists()) return;
        const data = snap.data();
        if (!data || data.status !== "trialing" || !data.trialEndsAt) { setDaysLeft(null); return; }
        const diffMs = data.trialEndsAt.toDate().getTime() - new Date().getTime();
        setDaysLeft(Math.floor(diffMs / (1000 * 60 * 60 * 24)));
      });
      return () => unsub();
    }, [user]);
    if (daysLeft === null) return null;
    if (daysLeft === 0) return <div style={{ background: "#dc2626", color: "#fff", padding: 12, margin: "8px 12px", borderRadius: 12, fontWeight: 700, textAlign: "center" }}>{t('trialExpiredBanner')}</div>;
    if (daysLeft <= 2) return <div style={{ background: "#f59e0b", color: "#000", padding: 12, margin: "8px 12px", borderRadius: 12, fontWeight: 800, textAlign: "center" }}>{t('trialLast', { d: daysLeft })}</div>;
    return <div style={{ background: "#22c55e", color: "#000", padding: 10, margin: "8px 12px", borderRadius: 12, fontWeight: 700, textAlign: "center" }}>{t('trialDays', { d: daysLeft })}</div>;
  }

  if (loading) return <div style={{ padding: 30 }}>{t('loading')}</div>;
  if (!user) return <Login />;
  if (checkingSubscription && !isAdmin) return <div style={{ padding: 30 }}>{t('checking')}</div>;
  const allowed = isAdmin || subscriptionStatus === "active" || subscriptionStatus === "trialing";
  if (!allowed && !isAdmin) {
    const createCheckout = httpsCallable(functions, "createCheckoutSession");
    const handleSubscribe = async () => {
      try { const result = await createCheckout(); window.location.href = (result.data as { url: string }).url; }
      catch { alert("Não foi possível iniciar o pagamento."); }
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", textAlign: "center", padding: 20 }}>
        <img src="/LogiFlow-Pro.png" alt="LogiFlow" style={{ height: "clamp(32px,6vw,48px)", width: "auto", maxWidth: "60%", objectFit: "contain", display: "block", marginTop: 6 }} />
        <h2>{t('subRequired')}</h2><p>{t('trialExpired')}</p>
        <button style={{ background: "#2563eb", color: "#fff", padding: "14px 22px", borderRadius: 12, fontWeight: 700, border: "2px solid #000" }} onClick={handleSubscribe}>{t('subscribe')}</button>
      </div>
    );
  }

  if (screen === "financeiro") {
    const fuelUsed = distanceKm / config.consumption;
    const revenue = concluidas.length * config.perDelivery;
    const fuelCostCalc = fuelUsed * config.fuelPrice;
    const profit = revenue - fuelCostCalc - config.fixedCost;
    return (
      <div style={{ padding: 20, background: darkMode ? "#111827" : "#f3f4f6", minHeight: "100vh", color: darkMode ? "#fff" : "#000", boxSizing: "border-box" }}>
        <button style={{ background: "#374151", color: "#fff", height: 52, width: "100%", border: "2px solid #000", borderRadius: 14, fontWeight: 700, marginBottom: 16 }} onClick={() => setScreen("operacao")}>{t('backToOps')}</button>
        <h2>{t('financeTitle')}</h2>
        <div style={{ background: darkMode ? "#1f2937" : "#374151", padding: 16, borderRadius: 16, marginBottom: 16, color: "#fff" }}>
          <h3 style={{ marginBottom: 12, color: "#fff" }}>{t('vehicleConfig')}</h3>
          <label style={{ display: "block", marginBottom: 4, fontWeight: 600, color: "#ccc" }}>{t('vehicleType')}</label>
          <select value={config.vehicleType} onChange={e => setConfig({ ...config, vehicleType: e.target.value })} style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "2px solid #000", background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000" }}><option>Moto</option><option>Carro</option><option>Van</option><option>Bicicleta elétrica</option></select>
          <label style={{ display: "block", marginBottom: 4, fontWeight: 600, color: "#ccc" }}>{t('consumption')}</label>
          <input type="number" step="0.1" value={config.consumption} onChange={e => setConfig({ ...config, consumption: parseFloat(e.target.value) || 1 })} style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "2px solid #000", background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000" }} />
          <label style={{ display: "block", marginBottom: 4, fontWeight: 600, color: "#ccc" }}>{t('fuelType')}</label>
          <select value={config.fuelType} onChange={e => setConfig({ ...config, fuelType: e.target.value })} style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "2px solid #000", background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000" }}><option>Gasoline</option><option>Diesel</option><option>Ethanol</option><option>Electric</option></select>
          <label style={{ display: "block", marginBottom: 4, fontWeight: 600, color: "#ccc" }}>{t('fuelPrice')}</label>
          <input type="number" step="0.01" value={config.fuelPrice} onChange={e => setConfig({ ...config, fuelPrice: parseFloat(e.target.value) || 0 })} style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "2px solid #000", background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000" }} />
          <label style={{ display: "block", marginBottom: 4, fontWeight: 600, color: "#ccc" }}>{t('currency')}</label>
          <input value={config.currency} onChange={e => setConfig({ ...config, currency: e.target.value })} style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "2px solid #000", background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000" }} />
          <label style={{ display: "block", marginBottom: 4, fontWeight: 600, color: "#ccc" }}>{t('unit')}</label>
          <select value={config.unit} onChange={e => setConfig({ ...config, unit: e.target.value })} style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "2px solid #000", background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000" }}><option value="km">KM</option><option value="mi">Miles</option></select>
          <label style={{ display: "block", marginBottom: 4, fontWeight: 600, color: "#ccc" }}>{t('perDelivery')}</label>
          <input type="number" step="0.01" value={config.perDelivery} onChange={e => setConfig({ ...config, perDelivery: parseFloat(e.target.value) || 0 })} style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "2px solid #000", background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000" }} />
          <label style={{ display: "block", marginBottom: 4, fontWeight: 600, color: "#ccc" }}>{t('fixedCosts')}</label>
          <input type="number" step="0.01" value={config.fixedCost} onChange={e => setConfig({ ...config, fixedCost: parseFloat(e.target.value) || 0 })} style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "2px solid #000", background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000" }} />
          <label style={{ display: "block", marginBottom: 4, fontWeight: 600, color: "#ccc" }}>{t('emergencyContactLabel')}</label>
          <input type="text" value={config.emergencyContact} onChange={e => setConfig({ ...config, emergencyContact: e.target.value })} style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "2px solid #000", background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000" }} placeholder="+5511999999999" />
        </div>
        <div style={{ background: darkMode ? "#1f2937" : "#ffffff", padding: 18, borderRadius: 16, marginTop: 12, color: darkMode ? "#fff" : "#000" }}>
          <p>{t('distance')}: {config.unit === "km" ? distanceKm.toFixed(1) + " km" : (distanceKm * 0.621371).toFixed(1) + " mi"}</p>
          <p>{t('fuelUsed')}: {fuelUsed.toFixed(2)} L</p>
          <p>{t('fuelCost')}: {config.currency} {fuelCostCalc.toFixed(2)}</p>
          <p>{t('deliveriesCompleted')}: {concluidas.length}</p>
          <p>{t('estimatedRevenue')}: {config.currency} {revenue.toFixed(2)}</p>
          <p>{t('fixedCosts')}: {config.currency} {config.fixedCost.toFixed(2)}</p>
          <h3 style={{ marginTop: 10, fontWeight: 800, color: profit >= 0 ? "#22c55e" : "#ef4444" }}>{t('netProfit')}: {config.currency} {profit.toFixed(2)}</h3>
        </div>
      </div>
    );
  }

  const header = { padding: "18px 18px", background: darkMode ? "#1f2937" : "#fff", position: "relative" as const, zIndex: 10 } as const;
  const stat = {
    background: darkMode ? "#374151" : "#f3f4f6", borderRadius: 16, padding: "12px 4px", textAlign: "center" as const,
    display: "flex" as const, flexDirection: "column" as const, fontWeight: 700, gap: 6,
    border: darkMode ? "1px solid #4b5563" : "1px solid #e5e7eb", boxShadow: "0 2px 4px rgba(0,0,0,0.05)", fontSize: "13px"
  } as const;
  const card = { background: darkMode ? "#1f2937" : "#fff", padding: 18, borderRadius: 16, marginBottom: 18 } as const;
  const cardHighlight = { ...card, border: "3px solid #22c55e", boxShadow: "0 0 0 3px rgba(34,197,94,0.25)" } as const;
  const app = {
    display: "flex" as const, flexDirection: "column" as const, height: "100vh", width: "100%",
    maxWidth: "100vw", overflow: "hidden" as const, fontFamily: "Inter, Arial", background: "#f3f4f6", boxSizing: "border-box" as const
  } as const;
  const list = {
    flex: 1, overflowY: "auto" as const, overflowX: "hidden" as const, padding: "18px 12px",
    paddingBottom: "140px", boxSizing: "border-box" as const, WebkitOverflowScrolling: "touch" as const
  } as const;
  const btn = (bg: string, color = "#fff") => ({
    background: bg, color, height: 52, width: "100%", border: "2px solid #000", borderRadius: 14,
    fontWeight: 700, fontSize: 15, display: "flex" as const, alignItems: "center" as const,
    justifyContent: "center" as const, boxSizing: "border-box" as const, padding: "0 8px"
  });
  const mini = (bg: string) => ({
    background: bg, color: "#fff", height: 44, width: "100%", borderRadius: 12,
    display: "flex" as const, alignItems: "center" as const, justifyContent: "center" as const,
    fontWeight: 700, fontSize: 12, border: "2px solid #000", textDecoration: "none" as const,
    whiteSpace: "nowrap" as const, overflow: "hidden" as const, textOverflow: "ellipsis" as const,
    lineHeight: 1, padding: "0 2px"
  });
  const overlay = { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.6)", display: "flex" as const, alignItems: "center" as const, justifyContent: "center" as const, zIndex: 10000 } as const;

  const HomeScreen = () => {
    const navigate = useNavigate();
    const [expanded, setExpanded] = useState<string | null>(null);
    const handleScannerCapture = (d: any) => {
      if (scannerCaptureLockRef.current) {
        console.warn("[scanner] lock ativo, ignorando nova captura");
        return;
      }
      scannerCaptureLockRef.current = true;
      console.log("[SCAN RAW] dados capturados:", d);
      const normalized = {
        name: d?.name?.trim() || "",
        company: d?.company?.trim() || "",
        street: d?.street?.trim() || "",
        district: d?.district?.trim() || "",
        city: d?.city?.trim() || "",
        state: d?.state?.trim() || "",
        postalCode: d?.postalCode?.trim() || "",
        country: d?.country?.trim() || "",
        phone: d?.phone?.trim() || ""
      };
      console.log("[SCAN NORMALIZED] name=%s company=%s street=%s district=%s city=%s state=%s postalCode=%s country=%s",
        normalized.name, normalized.company, normalized.street, normalized.district, normalized.city, normalized.state, normalized.postalCode, normalized.country);
      setScannerData(normalized);
      setIsProcessingScan(true);
    };
    const handleSaveFromScanner = async () => {
      if (scannerData && !isSavingScan) {
        const success = await save(scannerData);
        if (success) {
          setIsScannerOpen(false);
          setScannerData(null);
          setIsProcessingScan(false);
          scannerCaptureLockRef.current = false;
        }
      }
    };

    const lista = activeList;
    if (lista.length > 0) console.log('[HOME AUTH] ids:', lista.map(d => d.id).join(', '));
    if (lista.length > 0) console.log('[HOME RENDER] first item id:', lista[0].id);

    return (
      <div style={{ ...app, background: darkMode ? "#111827" : "#f3f4f6", color: darkMode ? "#fff" : "#000", position: "relative" }}>
        <div style={header}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <img src="/LogiFlow-Pro.png" alt="LogiFlow" style={{ height: "clamp(40px,7vw,60px)", width: "auto", maxWidth: "60%", objectFit: "contain", display: "block", marginTop: 6 }} />
            <div style={{ display: "flex", gap: 8 }}>
              <button style={{ background: "#16a34a", color: "#fff", border: "2px solid #000", borderRadius: 10, padding: "6px 10px", fontWeight: 700 }} onClick={() => setScreen("financeiro")}>💰</button>
              <button style={{ background: darkMode ? "#22c55e" : "#1e3a8a", color: "#fff", border: "2px solid #000", borderRadius: 10, padding: "6px 10px", fontWeight: 700 }} onClick={() => setDarkMode(!darkMode)}>{darkMode ? "🌞" : "🌙"}</button>
            </div>
          </div>
        </div>
        {offline && <div style={{ background: "#dc2626", color: "#fff", padding: 8, textAlign: "center", fontWeight: 700, marginBottom: 12 }}>{t('offline')}</div>}
        <GpsStatusBanner darkMode={darkMode} title={gpsTitle} subtitle={gpsSubtitle} status={gpsStatus} />
        {routeMessage && (
          <div style={{
            padding: "8px 12px",
            margin: "0 12px 12px 12px",
            borderRadius: 12,
            background: darkMode ? "#1e3a8a" : "#dbeafe",
            color: darkMode ? "#dbeafe" : "#1e3a8a",
            fontWeight: 500,
            fontSize: 14,
            border: darkMode ? "1px solid #2563eb" : "1px solid #93c5fd"
          }}>
            {routeMessage}
          </div>
        )}
        <NextDeliveryPanel
          darkMode={darkMode} t={t} proxima={nextDelivery} distancia={nextDistance} eta={nextEta}
          arrived={nextArrived} onComplete={completeDelivery} concluidasCount={concluidas.length} totalCount={all.length}
        />
        <TrialBanner user={user} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 6, marginBottom: 12 }}>
          <div style={stat}><b>{t('total')}</b><span style={{ fontSize: 16, fontWeight: 700 }}>{all.length}</span></div>
          <div style={stat}><b>{t('pendingStat')}</b><span style={{ fontSize: 16, fontWeight: 700 }}>{pendentes.length}</span></div>
          <div style={stat}><b>{t('completedStat')}</b><span style={{ fontSize: 16, fontWeight: 700 }}>{concluidas.length}</span></div>
          <div style={stat}><b>{t('today')}</b><span style={{ fontSize: 16, fontWeight: 700 }}>{hoje.length}</span></div>
          <div style={stat}><b>{t('remaining')}</b><span style={{ fontSize: 16, fontWeight: 700 }}>{faltamHoje.length}</span></div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12, zIndex: 10 }}>
          <button style={btn("#2563eb")} onClick={() => {
            setScannerData(null);
            setIsProcessingScan(false);
            scannerCaptureLockRef.current = false;
            setIsScannerOpen(true);
          }} disabled={isProcessingScan || isSavingScan}>{t('scan')}</button>
          <button style={btn("#374151")} onClick={() => setAdminOpen(!adminOpen)}>{t('menu')}</button>
        </div>
        {adminOpen && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <button style={btn("#0ea5e9")} onClick={() => navigate("/import")}>{t('import')}</button>
              <button style={btn("#059669")} onClick={handleVoice}>{t('speak')}</button>
              <button
                style={btn(rotaAtiva ? "#16a34a" : "#047857")}
                onClick={handleRoute}
                disabled={isRouteLoading || isProcessingScan || isSavingScan}
              >
                {isRouteLoading ? t('organizingRoute') : (rotaAtiva ? t('routeActive') : t('route'))}
              </button>
              <button style={btn("#9333ea")} onClick={() => navigate("/historico")}>{t('history')}</button>
            </div>
            <div style={{ marginBottom: 12 }}><button style={btn("#8b5cf6")} onClick={startVoiceDestination}>{t('voiceDest')}</button></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <button style={btn("#2563eb")} onClick={() => navigate("/pendentes")}>{t('pending')}</button>
              <button style={btn("#7c3aed")} onClick={() => navigate("/concluidas")}>{t('completed')}</button>
              <button style={btn("#4b5563")} onClick={() => signOut(auth)}>{t('logout')}</button>
            </div>
          </>
        )}
        <div
          ref={setHomeListNode}
          onScroll={(e: React.UIEvent<HTMLDivElement>) => {
            homeListScrollTopRef.current = e.currentTarget.scrollTop;
          }}
          style={{
            ...list,
            paddingBottom: "120px",
            minHeight: 0,
            touchAction: "pan-y",
            overscrollBehaviorY: "contain"
          }}
        >
          {lista.map((d, i) => {
            const shouldHighlight = nextDelivery?.id === d.id;
            const nomeExibido = getDisplayName(d);
            return (
              <div key={d.id} style={shouldHighlight ? cardHighlight : card}>
                <strong>{deliveryNumbersById[d.id] ?? i + 1}. {nomeExibido}</strong>
                {rotaAtiva && (
                  <span style={{
                    background: "#16a34a",
                    color: "#fff",
                    padding: "2px 6px",
                    borderRadius: 4,
                    fontSize: 12,
                    fontWeight: 700,
                    marginLeft: 8
                  }}>ROTA</span>
                )}
                {formatAddressLines(d).map((linha, idx) => <div key={idx}>{linha}</div>)}
                {d.phone && <div>📞 {d.phone}</div>}
                <button style={btn("#374151")} onClick={() => setExpanded(expanded === d.id ? null : d.id)}>{t('actions')}</button>
                {expanded === d.id && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    {d.phone && <a href={`tel:${d.phone}`} style={mini("#1e293b")}>{t('call')}</a>}
                    {d.phone && <button style={mini("#16a34a")} onClick={e => { e.stopPropagation(); aCaminho(d); }}>{t('whatsapp')}</button>}
                    {d.street && <a href={`https://waze.com/ul?q=${encodeURIComponent(getFullAddress(d))}`} target="_self" style={mini("#0ea5e9")}>{t('waze')}</a>}
                    {d.street && <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(getFullAddress(d))}`} target="_self" style={mini("#2563eb")}>{t('google')}</a>}
                    {d.phone && <button style={mini("#0ea5e9")} onClick={() => aCaminho(d)}>{t('enRoute')}</button>}
                    <button style={mini("#f59e0b")} onClick={() => tirarProva(d.id)}>{t('proof')}</button>
                    <button style={mini("#dc2626")} onClick={async (e) => { e.stopPropagation(); setExpanded(null); await deleteDelivery(d.id); }}>{t('delete')}</button>
                    {d.status === "nao_realizada" && <button style={mini("#16a34a")} onClick={async (e) => { e.stopPropagation(); setExpanded(null); await completeDelivery(d.id); }}>{t('complete')}</button>}
                    <button style={mini("#2563eb")} onClick={() => { setSignDelivery(d.id); setSignOpen(true); }}>{t('signature')}</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, width: "100%", maxWidth: "100vw", background: darkMode ? "#1f2937" : "#ffffff", borderTop: "2px solid #e5e7eb", display: "flex", flexDirection: "column", alignItems: "center", padding: "6px 4px", paddingBottom: "calc(6px + env(safe-area-inset-bottom))", zIndex: 999, boxSizing: "border-box" }}>
          <div style={{ display: "flex", width: "100%", gap: "4px", justifyContent: "space-between" }}>
            <button style={{ ...mini("#ea580c"), flex: 1 }} onClick={handleNextDeliveryNavigation}>{t('nextBtn')}</button>
            <button style={{ ...mini("#7c3aed"), flex: 1 }} onClick={handleArrivedCurrentDelivery}>{t('arrivedBtn2')}</button>
            <button style={{ ...mini("#dc2626"), flex: 1 }} onClick={handleSOS}>{t('sosBtn')}</button>
          </div>
          <div style={{ fontSize: 12, textAlign: "center", marginTop: 4, opacity: 0.7, color: darkMode ? "#fff" : "#000" }}>
            <a href="#" onClick={e => { e.preventDefault(); window.open("/help.html", "_blank"); }} style={{ color: "inherit", textDecoration: "none", margin: "0 4px" }}>{t('help')}</a> {" • "}
            <a href="#" onClick={e => { e.preventDefault(); window.open("/feedback.html", "_blank"); }} style={{ color: "inherit", textDecoration: "none", margin: "0 4px" }}>{t('feedback')}</a> {" • "}
            <a href="#" onClick={e => { e.preventDefault(); window.open("/privacy.html", "_blank"); }} style={{ color: "inherit", textDecoration: "none", margin: "0 4px" }}>{t('privacy')}</a>
          </div>
        </div>
        {isScannerOpen && (
          <div style={{ position: "fixed", inset: 0, background: "#000", zIndex: 9999, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            {scannerData ? (
              <div style={{ background: darkMode ? "#1f2937" : "#fff", color: darkMode ? "#fff" : "#000", padding: 26, borderRadius: 18, width: "90%", maxWidth: 420, textAlign: "center" }}>
                <h3>{scannerData.name || scannerData.company || "Destinatário"}</h3>
                <p>{scannerData.street}</p>
                <button style={btn("#16a34a")} onClick={handleSaveFromScanner} disabled={isSavingScan}>{isSavingScan ? "Salvando..." : t('save')}</button>
                <button style={btn("#6b7280")} onClick={() => {
                  setScannerData(null);
                  setIsProcessingScan(false);
                  scannerCaptureLockRef.current = false;
                }} disabled={isSavingScan}>{t('recapture')}</button>
                <button style={btn("#dc2626")} onClick={() => {
                  setIsScannerOpen(false);
                  setScannerData(null);
                  setIsProcessingScan(false);
                  scannerCaptureLockRef.current = false;
                }} disabled={isSavingScan}>{t('cancel')}</button>
              </div>
            ) : <CameraScanner onCapture={handleScannerCapture} onClose={() => {
              setIsScannerOpen(false);
              setIsProcessingScan(false);
              scannerCaptureLockRef.current = false;
            }} />}
          </div>
        )}
        {signOpen && <SignatureModal onClose={() => setSignOpen(false)} onSave={async dataUrl => { if (signDelivery) await updateDoc(doc(db, "deliveries", signDelivery), { signatureImage: dataUrl }); setSignOpen(false); }} darkMode={darkMode} />}
      </div>
    );
  };

  const ImportScreen = () => {
    const navigate = useNavigate();
    const [importText, setImportText] = useState("");
    const handleFileImport = (e: any) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => setImportText(String(reader.result || ""));
      reader.readAsText(file);
    };
    const extractPhoneAndAddress = (line: string): { phone?: string; address: string; name?: string; company?: string } => {
      let phone: string | undefined;
      let cleanedLine = line;
      const phoneMatch = line.match(/(?:^|\s)(\+?\d[\d\s\-\(\)]{7,}\d)/);
      if (phoneMatch) {
        phone = phoneMatch[1].replace(/\D/g, '');
        cleanedLine = line.replace(phoneMatch[1], '').trim();
      }
      const parts = cleanedLine.split(',').map(p => p.trim());
      let name: string | undefined;
      let company: string | undefined;
      let address: string;
      if (parts.length >= 2 && /^[a-zA-ZÀ-ÿ0-9\s&.-]+$/.test(parts[0]) && parts[0].split(' ').length <= 6) {
        if (parts[0].toLowerCase().includes('ltda') || parts[0].toLowerCase().includes('me') || parts[0].toLowerCase().includes('epp')) {
          company = parts[0];
        } else {
          name = parts[0];
        }
        address = parts.slice(1).join(', ');
      } else {
        address = cleanedLine;
      }
      return { phone, address, name, company };
    };
    const importarLista = async () => {
      if (!user || !importText.trim()) return;
      const linhas = importText.split("\n").map(l => l.trim()).filter(Boolean);
      for (const linha of linhas) {
        const { phone, address, name, company } = extractPhoneAndAddress(linha);
        if (!address) continue;
        await addDoc(collection(db, "deliveries"), {
          userId: user.uid,
          name: name || "",
          company: company || "",
          street: address,
          phone,
          latitude: null,
          longitude: null,
          status: "nao_realizada",
          createdAt: Timestamp.now()
        });
      }
      navigate("/");
    };
    return (
      <div style={{ ...app, background: darkMode ? "#111827" : "#f3f4f6", color: darkMode ? "#fff" : "#000", padding: 20 }}>
        <button style={btn("#374151")} onClick={() => navigate("/")}>{t('back')}</button>
        <h3 style={{ marginTop: 16, marginBottom: 12 }}>{t('importTitle')}</h3>
        <input type="file" accept=".txt,.csv" onChange={handleFileImport} style={{ marginBottom: 12 }} />
        <textarea style={{ width: "100%", height: 180, borderRadius: 10, padding: 10, background: darkMode ? "#374151" : "#fff", color: darkMode ? "#fff" : "#000", border: "1px solid #ccc", boxSizing: "border-box", marginBottom: 12 }} value={importText} onChange={e => setImportText(e.target.value)} placeholder={t('importPlaceholder')} />
        <button style={btn("#16a34a")} onClick={importarLista}>{t('importButton')}</button>
        <button style={{ ...btn("#6b7280"), marginTop: 8 }} onClick={() => navigate("/")}>{t('cancel')}</button>
      </div>
    );
  };

  const ConcluidasScreen = () => {
    const navigate = useNavigate();
    return (
      <div style={{ ...app, background: darkMode ? "#111827" : "#f3f4f6", color: darkMode ? "#fff" : "#000" }}>
        <div style={header}><img src="/LogiFlow-Pro.png" alt="LogiFlow" style={{ height: "clamp(40px,7vw,60px)", width: "auto", maxWidth: "60%", objectFit: "contain", display: "block", marginTop: 6 }} /></div>
        <NextDeliveryPanel
          darkMode={darkMode} t={t} proxima={nextDelivery} distancia={nextDistance} eta={nextEta}
          arrived={nextArrived} onComplete={completeDelivery} concluidasCount={concluidas.length} totalCount={all.length}
        />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, padding: "0 12px", marginBottom: 12 }}>
          <button style={btn("#374151")} onClick={() => navigate("/")}>{t('back')}</button>
          <button style={btn("#dc2626")} onClick={apagarTodasConcluidas}>{t('clearHistory')}</button>
        </div>
        <div
          ref={setConcluidasListNode}
          onScroll={(e: React.UIEvent<HTMLDivElement>) => {
            concluidasListScrollTopRef.current = e.currentTarget.scrollTop;
          }}
          style={{
            ...list,
            paddingBottom: "120px",
            minHeight: 0,
            touchAction: "pan-y",
            overscrollBehaviorY: "contain"
          }}
        >
          {concluidas.map((d, i) => (
            <div key={d.id} style={card}>
              <strong>{i + 1}. {getDisplayName(d)}</strong>
              {formatAddressLines(d).map((linha, idx) => <div key={idx}>{linha}</div>)}
              {d.phone && <div>📞 {d.phone}</div>}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const HistoricoScreen = () => {
    const navigate = useNavigate();
    const [selected, setSelected] = useState<string[]>([]);
    async function apagarSelecionadas() { for (const id of selected) await deleteDelivery(id); setSelected([]); }
    return (
      <div style={{ ...app, background: darkMode ? "#111827" : "#f3f4f6", color: darkMode ? "#fff" : "#000" }}>
        <div style={header}><img src="/LogiFlow-Pro.png" alt="LogiFlow" style={{ height: "clamp(40px,7vw,60px)", width: "auto", maxWidth: "60%", objectFit: "contain", display: "block", marginTop: 6 }} /></div>
        <NextDeliveryPanel
          darkMode={darkMode} t={t} proxima={nextDelivery} distancia={nextDistance} eta={nextEta}
          arrived={nextArrived} onComplete={completeDelivery} concluidasCount={concluidas.length} totalCount={all.length}
        />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, padding: "0 12px", marginBottom: 12 }}>
          <button style={btn("#374151")} onClick={() => navigate("/")}>{t('back')}</button>
          <button style={btn("#dc2626")} onClick={apagarTodasConcluidas}>{t('clearHistory')}</button>
        </div>
        {selected.length > 0 && <div style={{ padding: "0 12px", marginBottom: 12 }}><button style={btn("#dc2626")} onClick={apagarSelecionadas}>{t('deleteSelected', { c: selected.length })}</button></div>}
        <div style={{ ...list, paddingBottom: "120px", minHeight: 0 }}>
          {concluidas.map((d, i) => (
            <div key={d.id} style={card}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={selected.includes(d.id)} onChange={() => setSelected(prev => prev.includes(d.id) ? prev.filter(id => id !== d.id) : [...prev, d.id])} />
                <strong>{i + 1}. {getDisplayName(d)}</strong>
              </div>
              {formatAddressLines(d).map((linha, idx) => <div key={idx} style={{ marginLeft: 28 }}>{linha}</div>)}
              {d.phone && <div style={{ marginLeft: 28 }}>📞 {d.phone}</div>}
            </div>
          ))}
        </div>
      </div>
    );
  };

  function SignatureModal({ onClose, onSave, darkMode }: { onClose: () => void; onSave: (data: string) => void; darkMode: boolean }) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const drawing = useRef(false);
    function start(e: any) { const ctx = canvasRef.current!.getContext("2d")!; ctx.beginPath(); drawing.current = true; draw(e); }
    function end() { drawing.current = false; }
    function draw(e: any) { if (!drawing.current) return; const canvas = canvasRef.current!; const rect = canvas.getBoundingClientRect(); const ctx = canvas.getContext("2d")!; let x, y; if (e.touches) { x = e.touches[0].clientX - rect.left; y = e.touches[0].clientY - rect.top; } else { x = e.clientX - rect.left; y = e.clientY - rect.top; } ctx.lineWidth = 2; ctx.strokeStyle = "#000"; ctx.lineCap = "round"; ctx.lineTo(x, y); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x, y); }
    function clear() { canvasRef.current!.getContext("2d")!.clearRect(0, 0, canvasRef.current!.width, canvasRef.current!.height); }
    function save() { onSave(canvasRef.current!.toDataURL("image/png")); }
    return (
      <div style={overlay}>
        <div style={{ background: darkMode ? "#1f2937" : "#fff", color: darkMode ? "#fff" : "#000", padding: 26, borderRadius: 18, width: "90%", maxWidth: 420, textAlign: "center" }}>
          <h3>{t('signTitle')}</h3>
          <canvas ref={canvasRef} width={320} height={200} style={{ border: "2px solid #000", borderRadius: 8, touchAction: "none", background: "#fff" }} onMouseDown={start} onMouseMove={draw} onMouseUp={end} onMouseLeave={end} onTouchStart={start} onTouchMove={draw} onTouchEnd={end} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
            <button style={btn("#6b7280")} onClick={clear}>{t('clear')}</button>
            <button style={btn("#16a34a")} onClick={save}>{t('save')}</button>
          </div>
          <button style={btn("#dc2626")} onClick={onClose}>{t('cancel')}</button>
        </div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<HomeScreen />} />
      <Route path="/import" element={<ImportScreen />} />
      <Route path="/pendentes" element={
        <PendentesScreen
          darkMode={darkMode}
          activeList={activeList}
          all={all}
          rotaAtiva={rotaAtiva}
          autoMode={autoMode}
          setAutoMode={setAutoMode}
          pos={pos}
          t={t}
          onCompleteDelivery={completeDelivery}
          onDeleteDelivery={deleteDelivery}
          apagarTodasPendentes={apagarTodasPendentes}
          aCaminho={aCaminho}
          tirarProva={tirarProva}
          setSignDelivery={setSignDelivery}
          setSignOpen={setSignOpen}
          handleRoute={handleRoute}
          isRouteLoading={isRouteLoading}
          nextDelivery={nextDelivery}
          nextDistance={nextDistance}
          nextEta={nextEta}
          nextArrived={nextArrived}
          onNextDeliveryNavigation={handleNextDeliveryNavigation}
          onArrivedCurrentDelivery={handleArrivedCurrentDelivery}
          emergencyContact={config.emergencyContact}
          onSOS={handleSOS}
          gpsStatus={gpsStatus}
          gpsTitle={gpsTitle}
          gpsSubtitle={gpsSubtitle}
          routeMessage={routeMessage}
          showEmergencyPanel={showEmergencyPanel}
          setShowEmergencyPanel={setShowEmergencyPanel}
          emergencyContactInputRef={emergencyContactInputRef}
          onSaveEmergencyContact={(contact) => setConfig(prev => ({ ...prev, emergencyContact: contact }))}
          deliveryNumbersById={deliveryNumbersById}
        />
      } />
      <Route path="/concluidas" element={<ConcluidasScreen />} />
      <Route path="/historico" element={<HistoricoScreen />} />
    </Routes>
  );
}