import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import admin from "firebase-admin";
import Stripe from "stripe";
import * as crypto from "crypto";
import type OpenAI from "openai";
import type { ImageAnnotatorClient } from "@google-cloud/vision";

if (!admin.apps.length) {
  admin.initializeApp();
}

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

// ======================================================
// =================== HELPERS OCR/GEO ==================
// ======================================================

type ParsedLabel = {
  name?: string;
  street?: string;
  district?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  phone?: string;
  country?: string;
  warnings?: string[];
  rawText?: string;
};

type LatLng = {
  lat: number;
  lng: number;
};

type DistanceMatrixResult = {
  distances: number[][];
  durations: number[][];
};

type RouteApiResult = {
  distanceMeters: number;
  durationSeconds: number;
};

type OptimizeRouteDeliveryInput = {
  id: string;
  latitude: number;
  longitude: number;
};

type GeocodeNormalizedAddress = {
  street: string;
  district: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};

type GeocodeResult = {
  latitude: number | null;
  longitude: number | null;
  matchedAddress: string;
  queryUsed: string;
  confidence: number;
};

type RouteEvaluation = {
  order: number[];
  totalDurationSeconds: number;
  totalDistanceMeters: number;
  score: number;
};

type SegmentDetail = {
  fromType: "start" | "delivery";
  fromId: string;
  toId: string;
  durationSeconds: number;
  distanceMeters: number;
};

const poiIndicators = [
  "parque", "park", "jardim", "garden", "praça", "square", "plaza",
  "shopping", "mall", "centro comercial", "estádio", "stadium",
  "arena", "centro cultural", "cultural center", "terminal",
  "station", "campus", "hospital", "aeroporto", "airport", "universidade",
  "university", "hotel", "resort", "clube", "club", "sítio", "sitio",
  "fazenda", "farm", "condomínio", "condominium"
];

const noNumberIndicators = [
  "s/n", "sn", "sem número", "sin número", "no number", "s/nº", "s/n°"
];

function isWeakAddress(street: string): boolean {
  const lower = street.toLowerCase();
  if (noNumberIndicators.some(ind => lower.includes(ind))) return true;
  const hasStreetType = /(rua|avenida|av|travessa|alameda|estrada|rodovia|street|road|avenue|calle|carrera)/i.test(lower);
  const hasNumber = /\d/.test(street);
  if (hasStreetType && !hasNumber) return true;
  return false;
}

function isPoiInput(street: string): boolean {
  const lower = street.toLowerCase();
  return poiIndicators.some(ind => lower.includes(ind));
}

function isGenericCandidate(candidate: any): boolean {
  const klass = (candidate.class || "").toLowerCase();
  const type = (candidate.type || "").toLowerCase();
  const genericClasses = ["boundary", "landuse", "leisure", "natural", "place", "tourism"];
  const genericTypes = ["island", "peninsula", "forest", "park", "square", "plaza", "common",
                        "lake", "reservoir", "river", "beach", "bay", "golf_course"];
  return genericClasses.includes(klass) || genericTypes.includes(type);
}

function isLikelyRouteReady(candidate: any): boolean {
  const hasRoad = !!candidate?.address?.road;
  const hasHouse = !!candidate?.address?.house_number;
  if (hasRoad && !isGenericCandidate(candidate)) return true;
  if (hasRoad && hasHouse) return true;
  return false;
}

function hasStrongLocalityMatch(candidate: any, expected: GeocodeNormalizedAddress): boolean {
  const cityOk = expected.city && includesLoose(
    normalizeComparable(candidate?.address?.city || candidate?.address?.town || candidate?.address?.village || ""),
    expected.city
  );
  const stateOk = expected.state && includesLoose(
    normalizeComparable(candidate?.address?.state || ""),
    expected.state
  );
  return !!(cityOk && stateOk);
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function safeString(value: unknown): string {
  return typeof value === "string" ? normalizeSpaces(value) : "";
}

function normalizePhone(value: string): string {
  return value.replace(/[^\d+]/g, "").trim();
}

function normalizePostalCode(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanupField(value: string): string {
  return normalizeSpaces(
    value
      .replace(/^[,.\-:;]+/, "")
      .replace(/[,.\-:;]+$/, "")
      .trim()
  );
}

function titleCaseSmart(value: string): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .split(" ")
    .map((part) => {
      if (!part) return part;
      if (/^[A-Z0-9\-]{2,}$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function normalizeState(value: string): string {
  const v = cleanupField(value);
  if (!v) return "";
  if (v.length <= 3) return v.toUpperCase();
  return titleCaseSmart(v);
}

function normalizeCountry(value: string): string {
  const v = cleanupField(value);
  if (!v) return "";
  if (v.length <= 3) return v.toUpperCase();
  return titleCaseSmart(v);
}

function normalizeCity(value: string): string {
  const v = cleanupField(value);
  if (!v) return "";
  return titleCaseSmart(v);
}

function normalizeStreet(value: string): string {
  const v = cleanupField(value);
  if (!v) return "";
  return normalizeSpaces(v);
}

function normalizeDistrict(value: string): string {
  const v = cleanupField(value);
  if (!v) return "";
  return titleCaseSmart(v);
}

function normalizeName(value: string): string {
  const v = cleanupField(value);
  if (!v) return "";
  return normalizeSpaces(v);
}

function isDestinationMarker(line: string): boolean {
  const l = stripDiacritics(line.toLowerCase());
  return (
    /^destinatario\b/.test(l) ||
    /^destinataria\b/.test(l) ||
    /^recipient\b/.test(l) ||
    /^consignee\b/.test(l) ||
    /^deliver to\b/.test(l) ||
    /^ship to\b/.test(l) ||
    /^para\b/.test(l) ||
    /^entregar a\b/.test(l)
  );
}

function isSenderMarker(line: string): boolean {
  const l = stripDiacritics(line.toLowerCase());
  return (
    /^remetente\b/.test(l) ||
    /^sender\b/.test(l) ||
    /^shipper\b/.test(l) ||
    /^ship from\b/.test(l) ||
    /^from\b/.test(l) ||
    /^origem\b/.test(l) ||
    /^emitente\b/.test(l)
  );
}

function isHardStopLine(line: string): boolean {
  const l = stripDiacritics(line.toLowerCase());
  return (
    /^pedido\b/.test(l) ||
    /^order\b/.test(l) ||
    /^nota fiscal\b/.test(l) ||
    /^invoice\b/.test(l) ||
    /^nf[-\s]?\b/.test(l) ||
    /^danfe\b/.test(l) ||
    /^codigo de barras\b/.test(l) ||
    /^barcode\b/.test(l) ||
    /^qr\b/.test(l) ||
    /^tracking\b/.test(l) ||
    /^rastreio\b/.test(l) ||
    /^data entrega\b/.test(l) ||
    /^previsao\b/.test(l)
  );
}

function looksLikePhone(line: string): boolean {
  const digits = line.replace(/\D/g, "");
  return digits.length >= 8;
}

function looksLikePostalCode(line: string): boolean {
  const digits = line.replace(/\D/g, "");
  return digits.length >= 4 && digits.length <= 10;
}

function scoreRecipientBlock(lines: string[]): number {
  if (!lines.length) return 0;

  let score = 0;
  const joined = stripDiacritics(lines.join(" ").toLowerCase());

  if (joined.includes("destinatario")) score += 30;
  if (joined.includes("recipient")) score += 30;
  if (joined.includes("consignee")) score += 30;
  if (joined.includes("ship to")) score += 30;
  if (joined.includes("deliver to")) score += 30;

  const phoneLines = lines.filter(looksLikePhone).length;
  const postalLines = lines.filter(looksLikePostalCode).length;

  score += Math.min(lines.length, 8) * 2;
  score += phoneLines * 5;
  score += postalLines * 4;

  if (joined.includes("rua")) score += 4;
  if (joined.includes("avenida")) score += 4;
  if (joined.includes("av ")) score += 3;
  if (joined.includes("street")) score += 4;
  if (joined.includes("road")) score += 4;
  if (joined.includes("calle")) score += 4;
  if (joined.includes("cidade")) score += 3;
  if (joined.includes("city")) score += 3;
  if (joined.includes("estado")) score += 3;
  if (joined.includes("state")) score += 3;
  if (joined.includes("cep")) score += 3;
  if (joined.includes("zip")) score += 3;
  if (joined.includes("postcode")) score += 3;

  if (lines.some(isSenderMarker)) score -= 25;
  if (joined.includes("magalu")) score -= 8;
  if (joined.includes("remetente")) score -= 25;
  if (joined.includes("sender")) score -= 25;

  return score;
}

function extractRecipientBlock(text: string): string {
  const rawLines = text.replace(/\r/g, "").split("\n");
  const lines = rawLines.map((line) => normalizeSpaces(line));

  let bestBlock: string[] = [];
  let bestScore = -Infinity;

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i];
    if (!current) continue;

    if (isDestinationMarker(current)) {
      const block: string[] = [];
      const inlineContent = current
        .replace(/^\s*(destinat[aá]ri[oa]|recipient|consignee|deliver to|ship to|para|entregar a)\s*:?\s*/i, "")
        .trim();

      if (inlineContent) {
        block.push(inlineContent);
      }

      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (!next) {
          if (block.length >= 2) break;
          continue;
        }
        if (isSenderMarker(next)) break;
        if (isDestinationMarker(next) && block.length > 0) break;
        if (isHardStopLine(next) && block.length >= 2) break;

        block.push(next);
        if (block.length >= 8) break;
      }

      const score = scoreRecipientBlock([current, ...block]);
      if (score > bestScore) {
        bestScore = score;
        bestBlock = block.length ? block : [current];
      }
    }
  }

  if (bestBlock.length) {
    return bestBlock.join("\n").trim();
  }

  const blocks: string[][] = [];
  let currentBlock: string[] = [];

  for (const line of lines) {
    if (!line) {
      if (currentBlock.length) {
        blocks.push(currentBlock);
        currentBlock = [];
      }
      continue;
    }
    currentBlock.push(line);
  }
  if (currentBlock.length) blocks.push(currentBlock);

  for (const block of blocks) {
    const score = scoreRecipientBlock(block);
    if (score > bestScore) {
      bestScore = score;
      bestBlock = block;
    }
  }

  if (bestBlock.length) {
    return bestBlock.join("\n").trim();
  }

  return normalizeSpaces(text);
}

function cleanupOcrText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/QR[\s\S]*$/gi, "")
    .replace(/C[ÓO]DIGO\s*DE\s*BARRAS.*$/gim, "")
    .replace(/BARCODE.*$/gim, "")
    .replace(/DATA\s*ENTREGA.*$/gim, "")
    .replace(/PEDIDO.*$/gim, "")
    .replace(/MAGALU.*$/gim, "")
    .trim();
}

function buildWarnings(data: ParsedLabel): string[] {
  const warnings: string[] = [];

  const city = safeString(data.city);
  const state = safeString(data.state);
  const street = safeString(data.street);
  const name = safeString(data.name);
  const postalCode = safeString(data.postalCode);

  if (!street || street.length < 6) warnings.push("street_suspect");
  if (!name || name.length < 3) warnings.push("name_suspect");
  if (!city || city.length < 2) warnings.push("city_missing_or_suspect");
  if (!state || state.length < 2) warnings.push("state_missing_or_suspect");
  if (postalCode && postalCode.replace(/\D/g, "").length < 4) warnings.push("postal_code_suspect");

  return warnings;
}

function normalizeParsedLabel(input: any, rawText: string): ParsedLabel {
  const parsed: ParsedLabel = {
    name: normalizeName(safeString(input?.name)),
    street: normalizeStreet(safeString(input?.street)),
    district: normalizeDistrict(safeString(input?.district)),
    city: normalizeCity(safeString(input?.city)),
    state: normalizeState(safeString(input?.state)),
    postalCode: normalizePostalCode(safeString(input?.postalCode)),
    phone: normalizePhone(safeString(input?.phone)),
    country: normalizeCountry(safeString(input?.country)),
    rawText,
  };

  parsed.warnings = buildWarnings(parsed);
  return parsed;
}

function normalizeComparable(value?: string): string {
  return stripDiacritics(normalizeSpaces((value || "").toLowerCase()));
}

function includesLoose(haystack: string, needle?: string): boolean {
  const n = normalizeComparable(needle);
  if (!n) return false;
  if (haystack.includes(n)) return true;

  const tokens = n.split(" ").filter((t) => t.length >= 3);
  if (!tokens.length) return false;

  const matched = tokens.filter((token) => haystack.includes(token)).length;
  return matched >= Math.max(1, Math.ceil(tokens.length * 0.6));
}

function scoreNominatimCandidate(
  item: any,
  expected: {
    street?: string;
    district?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  }
): number {
  const haystack = normalizeComparable(
    [
      item?.display_name,
      item?.name,
      item?.address?.road,
      item?.address?.house_number,
      item?.address?.suburb,
      item?.address?.neighbourhood,
      item?.address?.city,
      item?.address?.town,
      item?.address?.village,
      item?.address?.state,
      item?.address?.postcode,
      item?.address?.country,
    ]
      .filter(Boolean)
      .join(" ")
  );

  const scoreToken = (value?: string, weight = 1) => {
    return includesLoose(haystack, value) ? weight : 0;
  };

  let score = 0;
  score += scoreToken(expected.street, 10);
  score += scoreToken(expected.district, 5);
  score += scoreToken(expected.city, 8);
  score += scoreToken(expected.state, 7);
  score += scoreToken(expected.postalCode, 9);
  score += scoreToken(expected.country, 4);

  if (item?.address?.road) {
    if (includesLoose(normalizeComparable(item.address.road), expected.street)) {
      score += 6;
    } else {
      score += 3;
    }
  }

  if (item?.address?.house_number) {
    score += 5;
  }

  if (isGenericCandidate(item)) {
    score -= 15;
  }

  const type = String(item?.type || "").toLowerCase();
  const klass = String(item?.class || "").toLowerCase();

  if (type.includes("house")) score += 4;
  if (type.includes("building")) score += 3;
  if (type.includes("residential")) score += 2;
  if (klass.includes("building")) score += 2;
  if (item?.importance) score += Math.min(Number(item.importance) * 2, 2);

  return score;
}

function validateGeocodeCandidate(
  item: any,
  expected: GeocodeNormalizedAddress,
  score: number
): boolean {
  const normalizedDisplay = normalizeComparable(item?.display_name || "");

  const cityOk =
    !expected.city ||
    includesLoose(normalizedDisplay, expected.city) ||
    includesLoose(
      normalizeComparable(
        item?.address?.city || item?.address?.town || item?.address?.village || ""
      ),
      expected.city
    );

  const stateOk =
    !expected.state ||
    includesLoose(normalizedDisplay, expected.state) ||
    includesLoose(normalizeComparable(item?.address?.state || ""), expected.state);

  const postalOk =
    !expected.postalCode ||
    includesLoose(normalizedDisplay, expected.postalCode) ||
    includesLoose(normalizeComparable(item?.address?.postcode || ""), expected.postalCode);

  const streetOk =
    !expected.street ||
    includesLoose(normalizedDisplay, expected.street) ||
    includesLoose(normalizeComparable(item?.address?.road || ""), expected.street);

  const districtOk =
    !expected.district ||
    includesLoose(normalizedDisplay, expected.district) ||
    includesLoose(
      normalizeComparable(
        item?.address?.suburb ||
          item?.address?.neighbourhood ||
          item?.address?.city_district ||
          ""
      ),
      expected.district
    );

  if (!cityOk && expected.city.length >= 3) return false;
  if (!stateOk && expected.state.length >= 2 && score < 16) return false;
  if (!postalOk && expected.postalCode.replace(/\D/g, "").length >= 5 && score < 16) return false;
  if (expected.street && expected.city && !streetOk && !districtOk && score < 14) return false;
  if (score < 10) return false;

  return true;
}

function buildGeocodeQueries(normalized: GeocodeNormalizedAddress, flags: { isPoi: boolean; isWeak: boolean }): string[] {
  const baseQueries = [
    [normalized.street, normalized.district, normalized.city, normalized.state, normalized.postalCode, normalized.country].filter(Boolean).join(", "),
    [normalized.street, normalized.city, normalized.state, normalized.postalCode, normalized.country].filter(Boolean).join(", "),
    [normalized.street, normalized.district, normalized.city, normalized.state, normalized.country].filter(Boolean).join(", "),
    [normalized.street, normalized.city, normalized.state, normalized.country].filter(Boolean).join(", "),
    [normalized.street, normalized.city, normalized.country].filter(Boolean).join(", "),
    [normalized.city, normalized.state, normalized.country].filter(Boolean).join(", "),
  ].filter(Boolean);

  if (flags.isPoi || flags.isWeak) {
    const additional = [
      [normalized.street, normalized.district, normalized.city, normalized.state, normalized.country].filter(Boolean).join(", "),
      [normalized.street, normalized.city, normalized.state, normalized.country].filter(Boolean).join(", "),
      [normalized.street, normalized.district, normalized.city].filter(Boolean).join(", "),
      [normalized.street, normalized.city].filter(Boolean).join(", "),
    ].filter(Boolean);
    return [...new Set([...baseQueries, ...additional])];
  }

  return [...new Set(baseQueries)];
}

async function searchNominatimCandidates(query: string, attempt = 1): Promise<any[]> {
  if (!query) return [];

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "LogiFlowPro/1.0",
      "Accept-Language": "en,es,pt",
    },
  });

  if (!response.ok) {
    if (response.status === 429 && attempt <= 2) {
      const delayMs = attempt * 1000; // 1s, 2s
      console.warn(`[geocodeAddress] HTTP 429, tentativa ${attempt}, aguardando ${delayMs}ms`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return searchNominatimCandidates(query, attempt + 1);
    }
    throw new Error(`Nominatim HTTP ${response.status}`);
  }

  const data: any = await response.json();
  return Array.isArray(data) ? data : [];
}

function isValidLatLng(point: any): point is LatLng {
  return (
    !!point &&
    typeof point.lat === "number" &&
    typeof point.lng === "number" &&
    !Number.isNaN(point.lat) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lng >= -180 &&
    point.lng <= 180
  );
}

async function fetchOsrmTable(points: LatLng[]): Promise<DistanceMatrixResult> {
  if (!points.length) {
    return { distances: [], durations: [] };
  }

  const coordinates = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const rawKey = coordinates;
  const cacheKey = crypto.createHash("sha256").update(rawKey).digest("hex");

  const firestore = admin.firestore();
  const cacheRef = firestore.collection("osrm_cache").doc(cacheKey);

  try {
    const cacheDoc = await cacheRef.get();
    if (cacheDoc.exists) {
      const data = cacheDoc.data();
      if (data && data.expiresAt && data.expiresAt.toDate() > new Date()) {
        console.log("[fetchOsrmTable] cache hit", { cacheKey });
        return {
          distances: JSON.parse(data.distancesStr),
          durations: JSON.parse(data.durationsStr),
        };
      }
    }
  } catch (err) {
    console.warn("[fetchOsrmTable] error reading cache", err);
  }

  const url = `https://router.project-osrm.org/table/v1/driving/${coordinates}?annotations=distance,duration`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "LogiFlowPro/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`OSRM HTTP ${response.status}`);
  }

  const data: any = await response.json();

  if (data?.code !== "Ok" || !Array.isArray(data?.distances) || !Array.isArray(data?.durations)) {
    throw new Error("OSRM retornou matriz inválida");
  }

  const size = points.length;

  if (data.distances.length !== size || data.durations.length !== size) {
    throw new Error("OSRM retornou número incorreto de linhas");
  }

  const distances = data.distances.map((row: any[], rowIndex: number) => {
    if (!Array.isArray(row) || row.length !== size) {
      throw new Error(`OSRM retornou linha distances inválida no índice ${rowIndex}`);
    }
    return row.map((value) => (typeof value === "number" ? value : Number.MAX_SAFE_INTEGER));
  });

  const durations = data.durations.map((row: any[], rowIndex: number) => {
    if (!Array.isArray(row) || row.length !== size) {
      throw new Error(`OSRM retornou linha durations inválida no índice ${rowIndex}`);
    }
    return row.map((value) => (typeof value === "number" ? value : Number.MAX_SAFE_INTEGER));
  });

  try {
    const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    await cacheRef.set({
      distancesStr: JSON.stringify(distances),
      durationsStr: JSON.stringify(durations),
      expiresAt,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn("[fetchOsrmTable] error saving to cache", err);
  }

  return { distances, durations };
}

async function fetchOsrmRoute(points: LatLng[]): Promise<RouteApiResult> {
  if (points.length < 2) {
    return {
      distanceMeters: 0,
      durationSeconds: 0,
    };
  }

  const coordinates = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=false&steps=false&alternatives=false`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "LogiFlowPro/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`OSRM route HTTP ${response.status}`);
  }

  const data: any = await response.json();

  if (data?.code !== "Ok" || !Array.isArray(data?.routes) || !data.routes[0]) {
    throw new Error("OSRM route inválida");
  }

  const route = data.routes[0];

  if (typeof route.distance !== "number" || typeof route.duration !== "number") {
    throw new Error("OSRM route sem distance/duration");
  }

  return {
    distanceMeters: route.distance,
    durationSeconds: route.duration,
  };
}

function isFiniteMatrixValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
}

function validateMatrixForRouting(matrix: DistanceMatrixResult, expectedSize: number): void {
  if (!Array.isArray(matrix.distances) || !Array.isArray(matrix.durations)) {
    throw new Error("Matriz ausente");
  }

  if (matrix.distances.length !== expectedSize || matrix.durations.length !== expectedSize) {
    throw new Error("Matriz com tamanho incorreto");
  }

  for (let i = 0; i < expectedSize; i++) {
    if (!Array.isArray(matrix.distances[i]) || matrix.distances[i].length !== expectedSize) {
      throw new Error(`Linha distances inválida no índice ${i}`);
    }
    if (!Array.isArray(matrix.durations[i]) || matrix.durations[i].length !== expectedSize) {
      throw new Error(`Linha durations inválida no índice ${i}`);
    }

    for (let j = 0; j < expectedSize; j++) {
      if (!isFiniteMatrixValue(matrix.distances[i][j])) {
        throw new Error(`Valor inválido em distances[${i}][${j}]`);
      }
      if (!isFiniteMatrixValue(matrix.durations[i][j])) {
        throw new Error(`Valor inválido em durations[${i}][${j}]`);
      }
    }
  }
}

function buildRoutePoints(start: LatLng, order: number[], deliveries: OptimizeRouteDeliveryInput[]): LatLng[] {
  return [
    start,
    ...order.map((idx) => ({
      lat: deliveries[idx].latitude,
      lng: deliveries[idx].longitude,
    })),
  ];
}

function evaluateRouteOrder(order: number[], matrix: DistanceMatrixResult): RouteEvaluation {
  let totalDurationSeconds = 0;
  let totalDistanceMeters = 0;

  let currentMatrixIndex = 0;

  for (const deliveryIndex of order) {
    const nextMatrixIndex = deliveryIndex + 1;

    const duration = matrix.durations[currentMatrixIndex]?.[nextMatrixIndex];
    const distance = matrix.distances[currentMatrixIndex]?.[nextMatrixIndex];

    if (!isFiniteMatrixValue(duration) || !isFiniteMatrixValue(distance)) {
      return {
        order,
        totalDurationSeconds: Number.MAX_SAFE_INTEGER,
        totalDistanceMeters: Number.MAX_SAFE_INTEGER,
        score: Number.MAX_SAFE_INTEGER,
      };
    }

    totalDurationSeconds += duration;
    totalDistanceMeters += distance;
    currentMatrixIndex = nextMatrixIndex;
  }

  return {
    order,
    totalDurationSeconds,
    totalDistanceMeters,
    score: totalDurationSeconds * 1000 + totalDistanceMeters,
  };
}

function compareRouteEvaluations(a: RouteEvaluation, b: RouteEvaluation): number {
  if (a.score !== b.score) return a.score - b.score;
  if (a.totalDurationSeconds !== b.totalDurationSeconds) return a.totalDurationSeconds - b.totalDurationSeconds;
  if (a.totalDistanceMeters !== b.totalDistanceMeters) return a.totalDistanceMeters - b.totalDistanceMeters;
  return a.order.join(",").localeCompare(b.order.join(","));
}

function buildSegmentDetails(
  order: number[],
  matrix: DistanceMatrixResult,
  deliveries: OptimizeRouteDeliveryInput[]
): SegmentDetail[] {
  const segments: SegmentDetail[] = [];
  let currentMatrixIndex = 0;
  let currentId = "__START__";
  let currentType: "start" | "delivery" = "start";

  for (const deliveryIndex of order) {
    const nextMatrixIndex = deliveryIndex + 1;
    segments.push({
      fromType: currentType,
      fromId: currentId,
      toId: deliveries[deliveryIndex].id,
      durationSeconds: matrix.durations[currentMatrixIndex]?.[nextMatrixIndex] ?? Number.MAX_SAFE_INTEGER,
      distanceMeters: matrix.distances[currentMatrixIndex]?.[nextMatrixIndex] ?? Number.MAX_SAFE_INTEGER,
    });

    currentMatrixIndex = nextMatrixIndex;
    currentId = deliveries[deliveryIndex].id;
    currentType = "delivery";
  }

  return segments;
}

function getNearestFirstDeliveryIndex(deliveryIndexes: number[], matrix: DistanceMatrixResult): number | null {
  let bestCandidate: number | null = null;
  let bestDuration = Number.MAX_SAFE_INTEGER;
  let bestDistance = Number.MAX_SAFE_INTEGER;

  for (const candidateIndex of deliveryIndexes) {
    const candidateMatrixIndex = candidateIndex + 1;
    const duration = matrix.durations[0]?.[candidateMatrixIndex];
    const distance = matrix.distances[0]?.[candidateMatrixIndex];

    if (!isFiniteMatrixValue(duration) || !isFiniteMatrixValue(distance)) continue;

    if (
      duration < bestDuration ||
      (duration === bestDuration && distance < bestDistance) ||
      (duration === bestDuration &&
        distance === bestDistance &&
        candidateIndex < (bestCandidate ?? Number.MAX_SAFE_INTEGER))
    ) {
      bestCandidate = candidateIndex;
      bestDuration = duration;
      bestDistance = distance;
    }
  }

  return bestCandidate;
}

function createInitialGreedyRoute(
  deliveryIndexes: number[],
  matrix: DistanceMatrixResult,
  forcedFirstIndex?: number | null
): number[] {
  const remaining = new Set<number>(deliveryIndexes);
  const order: number[] = [];
  let currentMatrixIndex = 0;

  if (forcedFirstIndex != null && remaining.has(forcedFirstIndex)) {
    order.push(forcedFirstIndex);
    remaining.delete(forcedFirstIndex);
    currentMatrixIndex = forcedFirstIndex + 1;
  }

  while (remaining.size > 0) {
    let bestCandidate: number | null = null;
    let bestDuration = Number.MAX_SAFE_INTEGER;
    let bestDistance = Number.MAX_SAFE_INTEGER;

    for (const candidateIndex of remaining) {
      const candidateMatrixIndex = candidateIndex + 1;
      const duration = matrix.durations[currentMatrixIndex]?.[candidateMatrixIndex];
      const distance = matrix.distances[currentMatrixIndex]?.[candidateMatrixIndex];

      if (!isFiniteMatrixValue(duration) || !isFiniteMatrixValue(distance)) continue;

      if (
        duration < bestDuration ||
        (duration === bestDuration && distance < bestDistance) ||
        (duration === bestDuration &&
          distance === bestDistance &&
          candidateIndex < (bestCandidate ?? Number.MAX_SAFE_INTEGER))
      ) {
        bestCandidate = candidateIndex;
        bestDuration = duration;
        bestDistance = distance;
      }
    }

    if (bestCandidate === null) break;

    order.push(bestCandidate);
    remaining.delete(bestCandidate);
    currentMatrixIndex = bestCandidate + 1;
  }

  for (const candidate of deliveryIndexes) {
    if (!order.includes(candidate)) {
      order.push(candidate);
    }
  }

  return order;
}

function buildCheapestInsertionRoute(
  deliveryIndexes: number[],
  matrix: DistanceMatrixResult,
  forcedFirstIndex: number
): number[] {
  if (deliveryIndexes.length === 0) return [];
  const route: number[] = [forcedFirstIndex];
  const remaining = new Set(deliveryIndexes);
  remaining.delete(forcedFirstIndex);

  while (remaining.size > 0) {
    let bestDelivery = -1;
    let bestPosition = -1;
    let bestIncrease = Infinity;

    for (const d of remaining) {
      const dMatrix = d + 1;
      for (let pos = 0; pos <= route.length; pos++) {
        const prev = pos === 0 ? 0 : route[pos - 1] + 1;
        const next = pos === route.length ? -1 : route[pos] + 1;
        let newCost = matrix.durations[prev][dMatrix];
        if (next !== -1) newCost += matrix.durations[dMatrix][next];
        let oldCost = 0;
        if (pos !== 0 && pos !== route.length) oldCost = matrix.durations[prev][next];
        const increase = newCost - oldCost;
        if (increase < bestIncrease - 1e-6) { // avoid floating point tie issues
          bestIncrease = increase;
          bestDelivery = d;
          bestPosition = pos;
        }
      }
    }
    if (bestDelivery === -1) break;
    route.splice(bestPosition, 0, bestDelivery);
    remaining.delete(bestDelivery);
  }
  return route;
}

function applyReinsertionSearch(
  initial: RouteEvaluation,
  matrix: DistanceMatrixResult,
  lockedPrefix = 0
): { best: RouteEvaluation; improvements: number } {
  let best = initial;
  let improvements = 0;
  let improved = true;

  while (improved) {
    improved = false;

    for (let from = lockedPrefix; from < best.order.length; from++) {
      for (let to = lockedPrefix; to < best.order.length; to++) {
        if (from === to) continue;

        const candidateOrder = [...best.order];
        const [moved] = candidateOrder.splice(from, 1);
        candidateOrder.splice(to, 0, moved);

        const evaluation = evaluateRouteOrder(candidateOrder, matrix);
        if (compareRouteEvaluations(evaluation, best) < 0) {
          best = evaluation;
          improvements++;
          improved = true;
        }
      }
    }
  }

  return { best, improvements };
}

function applySwapSearch(
  initial: RouteEvaluation,
  matrix: DistanceMatrixResult,
  lockedPrefix = 0
): { best: RouteEvaluation; improvements: number } {
  let best = initial;
  let improvements = 0;
  let improved = true;

  while (improved) {
    improved = false;

    for (let i = lockedPrefix; i < best.order.length - 1; i++) {
      for (let j = i + 1; j < best.order.length; j++) {
        const candidateOrder = [...best.order];
        [candidateOrder[i], candidateOrder[j]] = [candidateOrder[j], candidateOrder[i]];

        const evaluation = evaluateRouteOrder(candidateOrder, matrix);
        if (compareRouteEvaluations(evaluation, best) < 0) {
          best = evaluation;
          improvements++;
          improved = true;
        }
      }
    }
  }

  return { best, improvements };
}

function applyTwoOptSearch(
  initial: RouteEvaluation,
  matrix: DistanceMatrixResult,
  lockedPrefix = 0
): { best: RouteEvaluation; improvements: number } {
  let best = initial;
  let improvements = 0;
  let improved = true;

  while (improved) {
    improved = false;

    for (let i = lockedPrefix; i < best.order.length - 1; i++) {
      for (let j = i + 1; j < best.order.length; j++) {
        const candidateOrder = [
          ...best.order.slice(0, i),
          ...best.order.slice(i, j + 1).reverse(),
          ...best.order.slice(j + 1),
        ];

        const evaluation = evaluateRouteOrder(candidateOrder, matrix);
        if (compareRouteEvaluations(evaluation, best) < 0) {
          best = evaluation;
          improvements++;
          improved = true;
        }
      }
    }
  }

  return { best, improvements };
}

function buildTopCandidatesFromGreedyVariants(
  deliveryIndexes: number[],
  matrix: DistanceMatrixResult,
  forcedFirstIndex?: number | null
): RouteEvaluation[] {
  const candidates: RouteEvaluation[] = [];
  const seen = new Set<string>();

  const baseGreedyOrder = createInitialGreedyRoute(deliveryIndexes, matrix, forcedFirstIndex);
  const baseEval = evaluateRouteOrder(baseGreedyOrder, matrix);
  candidates.push(baseEval);
  seen.add(baseEval.order.join(","));

  const sortedFromForcedPoint = [...deliveryIndexes].filter((idx) => idx !== forcedFirstIndex).sort((a, b) => {
    const originMatrixIndex = forcedFirstIndex != null ? forcedFirstIndex + 1 : 0;
    const da = matrix.durations[originMatrixIndex]?.[a + 1] ?? Number.MAX_SAFE_INTEGER;
    const db = matrix.durations[originMatrixIndex]?.[b + 1] ?? Number.MAX_SAFE_INTEGER;
    const xa = matrix.distances[originMatrixIndex]?.[a + 1] ?? Number.MAX_SAFE_INTEGER;
    const xb = matrix.distances[originMatrixIndex]?.[b + 1] ?? Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
    return xa - xb;
  });

  const seedCount = Math.min(8, sortedFromForcedPoint.length);
  for (let seed = 0; seed < seedCount; seed++) {
    const forcedSecond = sortedFromForcedPoint[seed];
    const remaining = deliveryIndexes.filter((idx) => idx !== forcedFirstIndex && idx !== forcedSecond);
    const order: number[] = [];

    if (forcedFirstIndex != null) {
      order.push(forcedFirstIndex);
    }
    order.push(forcedSecond);

    let currentMatrixIndex = forcedSecond + 1;
    const remainingSet = new Set<number>(remaining);

    while (remainingSet.size > 0) {
      let bestCandidate: number | null = null;
      let bestDuration = Number.MAX_SAFE_INTEGER;
      let bestDistance = Number.MAX_SAFE_INTEGER;

      for (const candidateIndex of remainingSet) {
        const duration = matrix.durations[currentMatrixIndex]?.[candidateIndex + 1];
        const distance = matrix.distances[currentMatrixIndex]?.[candidateIndex + 1];
        if (!isFiniteMatrixValue(duration) || !isFiniteMatrixValue(distance)) continue;

        if (
          duration < bestDuration ||
          (duration === bestDuration && distance < bestDistance) ||
          (duration === bestDuration &&
            distance === bestDistance &&
            candidateIndex < (bestCandidate ?? Number.MAX_SAFE_INTEGER))
        ) {
          bestCandidate = candidateIndex;
          bestDuration = duration;
          bestDistance = distance;
        }
      }

      if (bestCandidate === null) break;
      order.push(bestCandidate);
      remainingSet.delete(bestCandidate);
      currentMatrixIndex = bestCandidate + 1;
    }

    for (const candidate of deliveryIndexes) {
      if (!order.includes(candidate)) order.push(candidate);
    }

    const evaluation = evaluateRouteOrder(order, matrix);
    const key = evaluation.order.join(",");
    if (!seen.has(key)) {
      candidates.push(evaluation);
      seen.add(key);
    }
  }

  candidates.sort(compareRouteEvaluations);
  return candidates.slice(0, Math.min(12, candidates.length));
}

// ======================================================
// ===================== SCAN LABEL ======================
// ======================================================

let visionClient: ImageAnnotatorClient | null = null;
let openaiClient: OpenAI | null = null;

async function getVisionClient(): Promise<ImageAnnotatorClient> {
  if (!visionClient) {
    const { ImageAnnotatorClient } = await import("@google-cloud/vision");
    visionClient = new ImageAnnotatorClient();
  }

  const client = visionClient;
  if (!client) {
    throw new Error("Vision client initialization failed");
  }

  return client;
}

async function getOpenAIClient(): Promise<OpenAI> {
  if (!openaiClient) {
    const { default: OpenAI } = await import("openai");
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  const client = openaiClient;
  if (!client) {
    throw new Error("OpenAI client initialization failed");
  }

  return client;
}

export const scanLabel = onCall(
  {
    region: "us-central1",
    secrets: [OPENAI_API_KEY],
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async (request) => {
    const { imageBase64 } = request.data;

    if (!imageBase64) {
      throw new HttpsError("invalid-argument", "imageBase64 não fornecido");
    }

    const vision = await getVisionClient();
    const [result] = await vision.textDetection({
      image: { content: imageBase64 },
    });

    const extractedText = result.textAnnotations?.[0]?.description || "";

    if (!extractedText) {
      throw new HttpsError("internal", "Nenhum texto detectado");
    }

    const preCleanedText = cleanupOcrText(extractedText);
    const recipientBlock = extractRecipientBlock(preCleanedText);
    const cleanedText = recipientBlock || preCleanedText;

    if (!cleanedText || cleanedText.trim().length < 10) {
      console.warn("[scanLabel] texto muito curto após limpeza, retornando erro");
      throw new HttpsError("internal", "Texto insuficiente para extração");
    }

    console.log("[scanLabel] OCR text length:", extractedText.length, "cleaned length:", cleanedText.length);

    const openai = await getOpenAIClient();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "Extraia dados do DESTINATÁRIO de etiqueta de entrega. Ignore remetente/loja/transportadora. App global. Retorne JSON: name, street, district, city, state, postalCode, phone, country. Campos ausentes: string vazia. Sem texto extra.",
        },
        {
          role: "user",
          content: cleanedText,
        },
      ],
    });

    const content = completion.choices[0]?.message?.content;

    if (!content) {
      throw new HttpsError("internal", "Resposta vazia da OpenAI");
    }

    const jsonMatch = content.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new HttpsError("internal", "JSON inválido");
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const normalized = normalizeParsedLabel(parsed, cleanedText);

    console.log("[scanLabel] JSON extraído:", normalized);
    return normalized;
  }
);

// ======================================================
// =================== GEOCODE ADDRESS ==================
// ======================================================

function buildLooseStreetVariants(streetValue: string): string[] {
  const base = fixCommonOcrIssues(streetValue);
  if (!base) return [];

  const variants = new Set<string>();
  variants.add(base);
  const stripped = normalizeSpaces(base.replace(/\bQuadra\b.*$/i, "").replace(/\bLote\b.*$/i, "").trim());
  if (stripped && stripped !== base) variants.add(stripped);
  return Array.from(variants).slice(0, 2);
}

function buildDistrictVariants(districtValue: string): string[] {
  const base = fixCommonOcrIssues(districtValue);
  if (!base) return [];
  return Array.from(new Set([base])).slice(0, 1);
}

function buildCityVariants(cityValue: string): string[] {
  const base = fixCommonOcrIssues(cityValue);
  if (!base) return [];
  return Array.from(new Set([base])).slice(0, 1);
}

function fixCommonOcrIssues(value: string): string {
  if (!value) return "";
  return normalizeSpaces(
    value
      .replace(/\bGo Onis\b/gi, "Goiania")
      .replace(/\bGoiania\b/gi, "Goiania")
      .replace(/\bGoi nia\b/gi, "Goiania")
      .replace(/\bG0iania\b/gi, "Goiania")
      .replace(/\bGoiâ?nia\b/gi, "Goiania")
      .replace(/\bJd\b/gi, "Jardim")
      .replace(/\bQd\b/gi, "Quadra")
      .replace(/\bLt\b/gi, "Lote")
      .replace(/\bAv\b[.]?/gi, "Avenida")
  );
}

export const geocodeAddress = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (request) => {
    const { street, district, city, state, postalCode, country } = request.data || {};

    const normalized: GeocodeNormalizedAddress = {
      street: normalizeStreet(safeString(street)),
      district: normalizeDistrict(safeString(district)),
      city: normalizeCity(safeString(city)),
      state: normalizeState(safeString(state)),
      postalCode: normalizePostalCode(safeString(postalCode)),
      country: normalizeCountry(safeString(country)),
    };

    const fullAddress = [
      normalized.street,
      normalized.district,
      normalized.city,
      normalized.state,
      normalized.postalCode,
      normalized.country
    ].filter(Boolean).join(" ");
    const normalizedFullAddress = normalizeComparable(fullAddress);
    const cacheKey = crypto.createHash("sha256").update(normalizedFullAddress).digest("hex");

    const firestore = admin.firestore();
    const cacheRef = firestore.collection("geocode_cache").doc(cacheKey);
    let cacheDoc;
    try {
      cacheDoc = await cacheRef.get();
      if (cacheDoc.exists) {
        const data = cacheDoc.data();
        if (data && isValidLatLng({ lat: data.latitude, lng: data.longitude })) {
          console.log("[geocodeAddress] cache hit", { cacheKey });
          return {
            latitude: data.latitude,
            longitude: data.longitude,
            matchedAddress: data.matchedAddress || "",
            queryUsed: data.queryUsed || "",
            confidence: data.confidence || 0,
          } satisfies GeocodeResult;
        }
      }
    } catch (err) {
      console.warn("[geocodeAddress] error reading cache, proceeding with geocoding", err);
    }

    const isWeak = isWeakAddress(normalized.street);
    const isPoi = isPoiInput(normalized.street);
    const addressFlags = { isPoi, isWeak };

    // Helper to clean street for geocoding matching
    function normalizeStreetForGeocode(streetRaw: string): string {
      let s = normalizeSpaces(streetRaw);
      if (!s) return "";

      // Remove common OCR noise prefixes
      const noisePrefixes = [
        /^LIV\s+/i,
        /^END\s*/i,
        /^END:\s*/i,
        /^DEST\s*/i,
        /^DEST:\s*/i,
        /^RUA:\s*/i,
        /^AV:\s*/i,
        /^AL:\s*/i,
        /^ROD:\s*/i,
        /^EST:\s*/i,
      ];
      for (const pattern of noisePrefixes) {
        s = s.replace(pattern, "");
      }

      // Expand common abbreviations
      const abbreviations: [RegExp, string][] = [
        [/\bAV\b/i, "Avenida"],
        [/\bR\b/i, "Rua"],
        [/\bAL\b/i, "Alameda"],
        [/\bROD\b/i, "Rodovia"],
        [/\bEST\b/i, "Estrada"],
        [/\bTRAV\b/i, "Travessa"],
      ];
      for (const [regex, replacement] of abbreviations) {
        s = s.replace(regex, replacement);
      }

      // Remove complement parts after the number (e.g., "755 QUADRA A LOTE 03 AO 06")
      const numberMatch = s.match(/\d+/);
      if (numberMatch) {
        const numberPos = numberMatch.index!;
        const afterNumber = s.substring(numberPos + numberMatch[0].length);
        const complementKeywords = /\b(QUADRA|LOTE|QD|LT|BLOCO|APT|APTO|SALA|CONJ|CONJUNTO|FUNDOS|ANEXO)\b/i;
        if (complementKeywords.test(afterNumber)) {
          s = s.substring(0, numberPos + numberMatch[0].length);
        }
      }

      s = normalizeSpaces(s);
      return s;
    }

    // Build street variants
    const streetVariants = buildLooseStreetVariants(normalized.street);
    const districtVariants = buildDistrictVariants(normalized.district);
    const cityVariants = buildCityVariants(normalized.city);

    // Create clean street for matching (use first variant or fallback)
    const normalizedStreetForMatch = normalizeStreetForGeocode(streetVariants[0] || normalized.street);

    // Build expanded object for matching with cleaned street
    const expanded: GeocodeNormalizedAddress = {
      street: normalizedStreetForMatch,  // ← key change: use cleaned street for matching
      district: districtVariants[0] || normalized.district,
      city: cityVariants[0] || normalized.city,
      state: fixCommonOcrIssues(normalized.state),
      postalCode: normalized.postalCode,
      country: normalized.country,
    };

    // Keep original street for logs
    console.log("[geocodeAddress] street original:", normalized.street);
    console.log("[geocodeAddress] street normalized for match:", normalizedStreetForMatch);
    console.log("[geocodeAddress] city original:", normalized.city);
    console.log("[geocodeAddress] city normalized:", expanded.city);

    // Build queries using cleaned street for the primary variants
    function buildEnhancedGeocodeQueries(expandedAddr: GeocodeNormalizedAddress, flags: { isPoi: boolean; isWeak: boolean }): string[] {
      const baseStreet = expandedAddr.street; // already cleaned
      const variants: string[] = [];

      const addVariant = (street: string, district: string, city: string, state: string, postalCode: string, country: string) => {
        const parts = [street, district, city, state, postalCode, country].filter(p => p && p.trim());
        if (parts.length) {
          const q = parts.join(", ");
          if (!variants.includes(q)) variants.push(q);
        }
      };

      // Most complete
      addVariant(baseStreet, expandedAddr.district, expandedAddr.city, expandedAddr.state, expandedAddr.postalCode, expandedAddr.country);
      // Without district
      addVariant(baseStreet, "", expandedAddr.city, expandedAddr.state, expandedAddr.postalCode, expandedAddr.country);
      // Without district and postal code
      addVariant(baseStreet, "", expandedAddr.city, expandedAddr.state, "", expandedAddr.country);
      // City + state + country
      addVariant("", "", expandedAddr.city, expandedAddr.state, "", expandedAddr.country);
      // Postal code + city + state + country
      addVariant("", "", expandedAddr.city, expandedAddr.state, expandedAddr.postalCode, expandedAddr.country);
      // Street + city + country
      addVariant(baseStreet, "", expandedAddr.city, "", "", expandedAddr.country);
      // Street only (fallback)
      addVariant(baseStreet, "", "", "", "", expandedAddr.country);

      // Also include the original street variant as a fallback
      if (baseStreet !== normalized.street) {
        addVariant(normalized.street, expandedAddr.district, expandedAddr.city, expandedAddr.state, expandedAddr.postalCode, expandedAddr.country);
      }

      return variants.slice(0, 7);
    }

    // Build queries using the cleaned street
    const allQueries: string[] = [];
    const selectedStreetVariants = streetVariants.slice(0, 2);
    for (const streetVariant of selectedStreetVariants) {
      // For each street variant, we also create a cleaned version (though we already have one for matching)
      const variantStreetClean = normalizeStreetForGeocode(streetVariant);
      const variantAddress: GeocodeNormalizedAddress = {
        street: variantStreetClean,
        district: expanded.district,
        city: expanded.city,
        state: expanded.state,
        postalCode: expanded.postalCode,
        country: expanded.country,
      };
      const queriesForVariant = buildEnhancedGeocodeQueries(variantAddress, addressFlags);
      allQueries.push(...queriesForVariant);
      if (allQueries.length >= 7) break;
    }

    // Add one fallback query if needed
    if (allQueries.length < 3) {
      allQueries.push([expanded.city, expanded.state, expanded.country].filter(Boolean).join(", "));
    }

    const uniqueQueries = Array.from(new Set(allQueries)).slice(0, 7);
    console.log("[geocodeAddress] queries finais (limitadas a 7):", uniqueQueries);

    try {
      type CandidateWithMeta = {
        item: any;
        score: number;
        query: string;
        validStrict: boolean;
        hasRoad: boolean;
        hasHouse: boolean;
        generic: boolean;
        roadMatch: boolean;
        localityStrong: boolean;
        likelyRouteReady: boolean;
      };
      let candidates: CandidateWithMeta[] = [];
      let strongCandidate: CandidateWithMeta | null = null;

      for (const queryText of uniqueQueries) {
        console.log(`[geocodeAddress] buscando query="${queryText}"`);

        let items: any[];
        try {
          items = await searchNominatimCandidates(queryText);
        } catch (error: any) {
          if (error.message.includes("HTTP 429")) {
            console.warn(`[geocodeAddress] HTTP 429 after retries, aborting and returning safe result (no cache)`);
            return {
              latitude: null,
              longitude: null,
              matchedAddress: "",
              queryUsed: queryText,
              confidence: 0,
            } satisfies GeocodeResult;
          }
          throw error;
        }
        console.log(`[geocodeAddress] query="${queryText}" candidates=${items.length}`);

        for (const item of items) {
          const score = scoreNominatimCandidate(item, expanded);
          const validStrict = validateGeocodeCandidate(item, expanded, score);
          const hasRoad = !!item?.address?.road;
          const hasHouse = !!item?.address?.house_number;
          const generic = isGenericCandidate(item);
          const roadMatch = hasRoad && includesLoose(normalizeComparable(item.address.road), expanded.street);
          const localityStrong = hasStrongLocalityMatch(item, expanded);
          const likelyRouteReady = isLikelyRouteReady(item);

          const candidate: CandidateWithMeta = {
            item,
            score,
            query: queryText,
            validStrict,
            hasRoad,
            hasHouse,
            generic,
            roadMatch,
            localityStrong,
            likelyRouteReady,
          };
          candidates.push(candidate);

          if (validStrict && roadMatch && localityStrong && likelyRouteReady && score >= 30) {
            strongCandidate = candidate;
            break;
          }

          const displayName = normalizeSpaces(item?.display_name || "");
          console.log(
            `[geocodeAddress] candidate score=${score} strict=${validStrict} roadMatch=${roadMatch} localityStrong=${localityStrong} "${displayName.substring(0, 50)}..."`
          );
        }

        if (strongCandidate) {
          console.log("[geocodeAddress] found strong candidate, stopping early");
          break;
        }
      }

      if (!strongCandidate && candidates.length === 0) {
        console.log("[geocodeAddress] GEOCODE_ALL_QUERIES_FAILED", { original: normalized, expanded });
        return {
          latitude: null,
          longitude: null,
          matchedAddress: "",
          queryUsed: "",
          confidence: 0,
        } satisfies GeocodeResult;
      }

      const strictCandidates = candidates.filter(c => c.validStrict);
      const looseCandidates = candidates.filter(c => !c.validStrict);

      const sortByPriority = (a: CandidateWithMeta, b: CandidateWithMeta): number => {
        if (a.roadMatch !== b.roadMatch) return a.roadMatch ? -1 : 1;
        if (a.localityStrong !== b.localityStrong) return a.localityStrong ? -1 : 1;
        if (a.likelyRouteReady !== b.likelyRouteReady) return a.likelyRouteReady ? -1 : 1;
        if (a.generic !== b.generic) return a.generic ? 1 : -1;
        return b.score - a.score;
      };

      let chosen: CandidateWithMeta;

      if (strictCandidates.length > 0) {
        strictCandidates.sort(sortByPriority);
        chosen = strictCandidates[0];
      } else if (looseCandidates.length > 0) {
        looseCandidates.sort(sortByPriority);
        chosen = looseCandidates[0];
      } else {
        chosen = candidates[0];
      }

      const chosenCandidate = chosen.item;
      const chosenQueryUsed = chosen.query;
      const chosenScore = chosen.score;
      const confidenceBase = chosen.validStrict ? chosenScore * 4 : chosenScore * 3;
      const confidence = Math.max(35, Math.min(100, Math.round(confidenceBase)));

      const lat = parseFloat(chosenCandidate.lat);
      const lng = parseFloat(chosenCandidate.lon);
      if (!isValidLatLng({ lat, lng })) {
        console.error("[geocodeAddress] coordenadas inválidas retornadas pelo Nominatim", { lat, lng });
        return {
          latitude: null,
          longitude: null,
          matchedAddress: "",
          queryUsed: chosenQueryUsed,
          confidence: 0,
        } satisfies GeocodeResult;
      }

      const finalResult: GeocodeResult = {
        latitude: lat,
        longitude: lng,
        matchedAddress: normalizeSpaces(chosenCandidate.display_name || ""),
        queryUsed: chosenQueryUsed,
        confidence,
      };

      console.log("[geocodeAddress] resultado final:", {
        input: normalized,
        output: finalResult,
        confidence,
        winningQuery: chosenQueryUsed,
      });

      // Write to cache with merge (no extra read)
      try {
        const cacheData = {
          latitude: finalResult.latitude,
          longitude: finalResult.longitude,
          matchedAddress: finalResult.matchedAddress,
          queryUsed: finalResult.queryUsed,
          confidence: finalResult.confidence,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await cacheRef.set(cacheData, { merge: true });
      } catch (err) {
        console.warn("[geocodeAddress] error saving to cache", err);
      }

      return finalResult;
    } catch (error) {
      console.error("[geocodeAddress] erro:", error);
      return {
        latitude: null,
        longitude: null,
        matchedAddress: "",
        queryUsed: "",
        confidence: 0,
      } satisfies GeocodeResult;
    }
  }
);

// ======================================================
// ================= GET DISTANCE MATRIX =================
// ======================================================

export const getDistanceMatrix = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (request) => {
    const { points } = request.data || {};

    console.log("[getDistanceMatrix] chamada recebida");

    if (!Array.isArray(points) || points.length < 2) {
      throw new HttpsError("invalid-argument", "É necessário enviar pelo menos 2 pontos em request.data.points");
    }

    if (points.length > 25) {
      throw new HttpsError("invalid-argument", "Máximo de 25 pontos por chamada");
    }

    const normalizedPoints: LatLng[] = points.map((p: any) => ({
      lat: Number(p?.lat),
      lng: Number(p?.lng),
    }));

    const invalidIndex = normalizedPoints.findIndex((p) => !isValidLatLng(p));
    if (invalidIndex !== -1) {
      throw new HttpsError("invalid-argument", `Ponto inválido no índice ${invalidIndex}`);
    }

    try {
      const matrix = await fetchOsrmTable(normalizedPoints);
      console.log("[getDistanceMatrix] matriz OSRM retornada com sucesso");
      return matrix;
    } catch (error) {
      console.error("getDistanceMatrix error:", error);
      throw new HttpsError("internal", "Falha ao obter matriz viária");
    }
  }
);

// ======================================================
// ==================== OPTIMIZE ROUTE ===================
// ======================================================

function getShortAddress(delivery: OptimizeRouteDeliveryInput, originalDataMap: Map<string, any>): string {
  const orig = originalDataMap.get(delivery.id);
  if (orig) {
    const street = orig.street || "";
    const district = orig.district || "";
    const city = orig.city || "";
    return [street, district, city].filter(Boolean).join(", ") || "sem endereço";
  }
  return `${delivery.id.substring(0,6)} (${delivery.latitude.toFixed(4)},${delivery.longitude.toFixed(4)})`;
}

export const optimizeRoute = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async (request) => {
    try {
      console.log("[optimizeRoute] chamada recebida");

      const { startPos, deliveries } = request.data || {};

      if (!startPos || typeof startPos !== "object") {
        throw new HttpsError("invalid-argument", "startPos é obrigatório");
      }

      const normalizedStart: LatLng = {
        lat: Number(startPos?.lat),
        lng: Number(startPos?.lon ?? startPos?.lng),
      };

      if (!isValidLatLng(normalizedStart)) {
        throw new HttpsError("invalid-argument", "startPos inválido");
      }

      if (!Array.isArray(deliveries) || deliveries.length === 0) {
        throw new HttpsError("invalid-argument", "deliveries é obrigatório");
      }

      if (deliveries.length > 120) {
        throw new HttpsError("invalid-argument", "Máximo de 120 entregas por chamada");
      }

      const validDeliveries: OptimizeRouteDeliveryInput[] = [];
      const invalidDeliveries: { id: string }[] = [];

      // Keep original data for address logging
      const originalDataMap = new Map<string, any>();
      for (const d of deliveries) {
        originalDataMap.set(d.id, d);
      }

      for (const d of deliveries) {
        const id = safeString(d?.id);
        const latitude = Number(d?.latitude);
        const longitude = Number(d?.longitude);
        if (!id) {
          throw new HttpsError("invalid-argument", `Entrega sem id: ${JSON.stringify(d)}`);
        }
        if (isValidLatLng({ lat: latitude, lng: longitude })) {
          validDeliveries.push({ id, latitude, longitude });
        } else {
          invalidDeliveries.push({ id });
        }
      }

      const seenIds = new Set<string>();
      for (const d of validDeliveries) {
        if (seenIds.has(d.id)) {
          throw new HttpsError("invalid-argument", `ID duplicado: ${d.id}`);
        }
        seenIds.add(d.id);
      }
      for (const d of invalidDeliveries) {
        if (seenIds.has(d.id)) {
          throw new HttpsError("invalid-argument", `ID duplicado: ${d.id}`);
        }
        seenIds.add(d.id);
      }

      console.log(`[optimizeRoute] valid deliveries: ${validDeliveries.length}, invalid: ${invalidDeliveries.length}`);

      // AUDIT: validDeliveries raw with addresses
      const validWithAddress = validDeliveries.map((d, idx) => {
        const orig = originalDataMap.get(d.id);
        const street = orig?.street || "";
        const district = orig?.district || "";
        const city = orig?.city || "";
        const addr = [street, district, city].filter(Boolean).join(", ");
        return {
          idx,
          id: d.id,
          address: addr || "sem endereço",
          lat: d.latitude,
          lng: d.longitude,
        };
      });
      console.log("[AUDIT] validDeliveries raw:", JSON.stringify(validWithAddress, null, 2));

      if (validDeliveries.length === 0) {
        const orderedIds = deliveries.map((d: any) => d.id);
        const orderedDeliveries = deliveries.map((d: any) => ({
          id: d.id,
          latitude: null,
          longitude: null,
        }));
        console.warn("[optimizeRoute] fallback: nenhuma entrega válida, mantendo ordem original");
        return {
          orderedIds,
          orderedValidIds: [],
          invalidIdsAtEnd: orderedIds,
          orderedDeliveries,
          firstLegDistanceMeters: null,
          firstLegDurationSeconds: null,
          totalDistanceMeters: 0,
          totalDurationSeconds: 0,
          sourceUsed: normalizedStart,
          matrixSource: "original_order_fallback_no_valid",
          optimizationMode: "original_order_fallback",
          fallbackUsed: true,
          iterations: { reinsertion: 0, swap: 0, twoOpt: 0 },
          segments: [],
        };
      }

      const points: LatLng[] = [
        normalizedStart,
        ...validDeliveries.map((d) => ({ lat: d.latitude, lng: d.longitude })),
      ];

      let matrix: DistanceMatrixResult;
      try {
        matrix = await fetchOsrmTable(points);
        validateMatrixForRouting(matrix, points.length);
      } catch (error) {
        console.error("[optimizeRoute][err01] falha matriz OSRM:", error);

        const orderedValidIds = validDeliveries.map(d => d.id);
        const invalidIdsAtEnd = invalidDeliveries.map(d => d.id);
        const orderedIds = [...orderedValidIds, ...invalidIdsAtEnd];
        const orderedDeliveries = [
          ...validDeliveries.map(d => ({ id: d.id, latitude: d.latitude, longitude: d.longitude })),
          ...invalidDeliveries.map(d => ({ id: d.id, latitude: null, longitude: null })),
        ];
        let firstLegDistanceMeters: number | null = null;
        let firstLegDurationSeconds: number | null = null;
        if (validDeliveries.length > 0) {
          try {
            const firstLegRoute = await fetchOsrmRoute([normalizedStart, { lat: validDeliveries[0].latitude, lng: validDeliveries[0].longitude }]);
            firstLegDistanceMeters = firstLegRoute.distanceMeters;
            firstLegDurationSeconds = firstLegRoute.durationSeconds;
          } catch (e) {
            console.warn("[optimizeRoute] could not compute first leg separately", e);
          }
        }
        console.warn("[optimizeRoute] fallback: OSRM falhou, mantendo ordem original com first leg calculado se possível");
        return {
          orderedIds,
          orderedValidIds,
          invalidIdsAtEnd,
          orderedDeliveries,
          firstLegDistanceMeters,
          firstLegDurationSeconds,
          totalDistanceMeters: 0,
          totalDurationSeconds: 0,
          sourceUsed: normalizedStart,
          matrixSource: "original_order_fallback",
          optimizationMode: "original_order_fallback",
          fallbackUsed: true,
          iterations: { reinsertion: 0, swap: 0, twoOpt: 0 },
          segments: [],
        };
      }

      // AUDIT: matrix index map
      const matrixMap = validDeliveries.map((d, idx) => {
        const matrixIdx = idx + 1;
        const orig = originalDataMap.get(d.id);
        const street = orig?.street || "";
        const district = orig?.district || "";
        const city = orig?.city || "";
        const addr = [street, district, city].filter(Boolean).join(", ");
        return { matrixIdx, id: d.id, address: addr || "sem endereço" };
      });
      console.log("[AUDIT] matrix index map:", JSON.stringify(matrixMap, null, 2));

      // AUDIT: matrix from start
      const startToDeliveries = validDeliveries.map((d, idx) => {
        const matrixIdx = idx + 1;
        const duration = matrix.durations[0]?.[matrixIdx];
        const distance = matrix.distances[0]?.[matrixIdx];
        const orig = originalDataMap.get(d.id);
        const street = orig?.street || "";
        const district = orig?.district || "";
        const city = orig?.city || "";
        const addr = [street, district, city].filter(Boolean).join(", ");
        return {
          idx,
          id: d.id,
          address: addr || "sem endereço",
          duration,
          distance,
        };
      });
      console.log("[AUDIT] matrix from start:", JSON.stringify(startToDeliveries, null, 2));

      // AUDIT: duplicate coordinate check
      const coordMap = new Map<string, string[]>();
      for (const d of validDeliveries) {
        const key = `${d.latitude.toFixed(5)},${d.longitude.toFixed(5)}`;
        if (!coordMap.has(key)) coordMap.set(key, []);
        coordMap.get(key)!.push(d.id);
      }
      for (const [coords, ids] of coordMap.entries()) {
        if (ids.length > 1) {
          console.warn(`[AUDIT] POSSIBLE_DUPLICATE_COORDS: ${coords} appears for ids: ${ids.join(", ")}`);
        }
      }

      const deliveryIndexes = validDeliveries.map((_, idx) => idx);
      const forcedFirstIndex = getNearestFirstDeliveryIndex(deliveryIndexes, matrix);
      const forcedFirstId = forcedFirstIndex !== null ? validDeliveries[forcedFirstIndex].id : null;
      const forcedFirstOrig = forcedFirstId ? originalDataMap.get(forcedFirstId) : null;
      const forcedFirstAddress = forcedFirstOrig ? [forcedFirstOrig.street, forcedFirstOrig.district, forcedFirstOrig.city].filter(Boolean).join(", ") : "desconhecido";
      console.log("[AUDIT] forced first:", JSON.stringify({
        forcedFirstIndex,
        forcedFirstId,
        forcedFirstAddress,
        durationFromStart: forcedFirstIndex !== null ? matrix.durations[0]?.[forcedFirstIndex + 1] : null,
        distanceFromStart: forcedFirstIndex !== null ? matrix.distances[0]?.[forcedFirstIndex + 1] : null,
      }, null, 2));

      if (forcedFirstIndex === null) {
        // Fallback: original order
        const orderedValidIds = validDeliveries.map(d => d.id);
        const invalidIdsAtEnd = invalidDeliveries.map(d => d.id);
        const orderedIds = [...orderedValidIds, ...invalidIdsAtEnd];
        const orderedDeliveries = [
          ...validDeliveries.map(d => ({ id: d.id, latitude: d.latitude, longitude: d.longitude })),
          ...invalidDeliveries.map(d => ({ id: d.id, latitude: null, longitude: null })),
        ];
        console.warn("[optimizeRoute] forcedFirstIndex null, keeping original order");
        return {
          orderedIds,
          orderedValidIds,
          invalidIdsAtEnd,
          orderedDeliveries,
          firstLegDistanceMeters: null,
          firstLegDurationSeconds: null,
          totalDistanceMeters: 0,
          totalDurationSeconds: 0,
          sourceUsed: normalizedStart,
          matrixSource: "forced_first_null",
          optimizationMode: "original_order_fallback",
          fallbackUsed: true,
          iterations: { reinsertion: 0, swap: 0, twoOpt: 0 },
          segments: [],
        };
      }

      // Generate diverse initial candidate routes
      const greedyVariants = buildTopCandidatesFromGreedyVariants(deliveryIndexes, matrix, forcedFirstIndex);
      const insertionRouteOrder = buildCheapestInsertionRoute(deliveryIndexes, matrix, forcedFirstIndex);
      const insertionRouteEval = evaluateRouteOrder(insertionRouteOrder, matrix);

      // Combine and deduplicate by order string
      const candidateMap = new Map<string, RouteEvaluation>();
      for (const candidate of greedyVariants) {
        const key = candidate.order.join(",");
        if (!candidateMap.has(key)) {
          candidateMap.set(key, candidate);
        }
      }
      const insertionKey = insertionRouteEval.order.join(",");
      if (!candidateMap.has(insertionKey)) {
        candidateMap.set(insertionKey, insertionRouteEval);
      }
      let allCandidates = Array.from(candidateMap.values());
      allCandidates.sort(compareRouteEvaluations);

      // Determine how many candidates to refine based on route size
      const totalDeliveries = validDeliveries.length;
      let maxCandidates = 6;
      if (totalDeliveries <= 30) maxCandidates = 8;
      else if (totalDeliveries <= 70) maxCandidates = 6;
      else maxCandidates = 4;
      const candidatesToProcess = allCandidates.slice(0, maxCandidates);

      let bestRouteEval: RouteEvaluation | null = null;
      let bestReinsertion = 0, bestSwap = 0, bestTwoOpt = 0;

      for (const candidate of candidatesToProcess) {
        let currentEval = candidate;
        const locked = 1; // keep first stop fixed
        const reinsertionResult = applyReinsertionSearch(currentEval, matrix, locked);
        currentEval = reinsertionResult.best;
        const swapResult = applySwapSearch(currentEval, matrix, locked);
        currentEval = swapResult.best;
        const twoOptResult = applyTwoOptSearch(currentEval, matrix, locked);
        currentEval = twoOptResult.best;

        if (!bestRouteEval || compareRouteEvaluations(currentEval, bestRouteEval) < 0) {
          bestRouteEval = currentEval;
          bestReinsertion = reinsertionResult.improvements;
          bestSwap = swapResult.improvements;
          bestTwoOpt = twoOptResult.improvements;
        }
      }

      if (!bestRouteEval) {
        // fallback (should never happen)
        const fallbackOrder = createInitialGreedyRoute(deliveryIndexes, matrix, forcedFirstIndex);
        bestRouteEval = evaluateRouteOrder(fallbackOrder, matrix);
      }

      // AUDIT: best candidate raw order
      const bestOrderIndexes = bestRouteEval.order;
      const bestOrderIds = bestOrderIndexes.map(i => validDeliveries[i].id);
      const bestOrderAddresses = bestOrderIds.map(id => {
        const orig = originalDataMap.get(id);
        const street = orig?.street || "";
        const district = orig?.district || "";
        const city = orig?.city || "";
        return [street, district, city].filter(Boolean).join(", ") || "sem endereço";
      });
      console.log("[AUDIT] best candidate raw order:", JSON.stringify({
        indexes: bestOrderIndexes,
        ids: bestOrderIds,
        addresses: bestOrderAddresses,
      }, null, 2));

      let finalDistanceMeters = bestRouteEval.totalDistanceMeters;
      let finalDurationSeconds = bestRouteEval.totalDurationSeconds;

      if (validDeliveries.length <= 6) {
        try {
          const finalRouteApi = await fetchOsrmRoute(buildRoutePoints(normalizedStart, bestRouteEval.order, validDeliveries));
          finalDistanceMeters = finalRouteApi.distanceMeters;
          finalDurationSeconds = finalRouteApi.durationSeconds;
          console.log("[optimizeRoute] final route api validated:", JSON.stringify(finalRouteApi));
        } catch (error) {
          console.warn("[optimizeRoute] final route api validation failed; keeping matrix totals:", error);
        }
      }

      const orderedValidIds = bestRouteEval.order.map((idx) => validDeliveries[idx].id);
      const invalidIdsAtEnd = invalidDeliveries.map(d => d.id);
      const orderedIds = [...orderedValidIds, ...invalidIdsAtEnd];
      const orderedDeliveries = [
        ...bestRouteEval.order.map((idx) => ({
          id: validDeliveries[idx].id,
          latitude: validDeliveries[idx].latitude,
          longitude: validDeliveries[idx].longitude,
        })),
        ...invalidDeliveries.map(d => ({ id: d.id, latitude: null, longitude: null })),
      ];

      // AUDIT: final ordered deliveries with addresses
      const finalOrderedWithAddress = orderedDeliveries.map((d, pos) => {
        const orig = originalDataMap.get(d.id);
        const street = orig?.street || "";
        const district = orig?.district || "";
        const city = orig?.city || "";
        const addr = [street, district, city].filter(Boolean).join(", ");
        return {
          pos,
          id: d.id,
          address: addr || "sem endereço",
          lat: d.latitude,
          lng: d.longitude,
        };
      });
      console.log("[AUDIT] final ordered deliveries:", JSON.stringify(finalOrderedWithAddress, null, 2));

      // AUDIT: mapping integrity check
      const expectedIds = bestRouteEval.order.map(i => validDeliveries[i].id);
      const actualIds = orderedDeliveries.map(d => d.id);
      if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
        console.error("[AUDIT] ROUTE_MAPPING_MISMATCH: expected ids:", expectedIds, "actual ids:", actualIds);
      } else {
        console.log("[AUDIT] mapping integrity: OK");
      }

      const segments = buildSegmentDetails(bestRouteEval.order, matrix, validDeliveries);

      const firstLegDistanceMeters = segments.length > 0 ? segments[0].distanceMeters : null;
      const firstLegDurationSeconds = segments.length > 0 ? segments[0].durationSeconds : null;

      console.log("[optimizeRoute] orderedIds:", JSON.stringify(orderedIds));
      console.log("[optimizeRoute] first stop:", JSON.stringify({
        id: orderedIds[0] ?? null,
        firstLegDistanceMeters,
        firstLegDurationSeconds,
      }));

      return {
        orderedIds,
        orderedValidIds,
        invalidIdsAtEnd,
        orderedDeliveries,
        firstLegDistanceMeters,
        firstLegDurationSeconds,
        totalDistanceMeters: finalDistanceMeters,
        totalDurationSeconds: finalDurationSeconds,
        sourceUsed: normalizedStart,
        matrixSource: "osrm",
        optimizationMode: "multi_start_greedy_with_local_search",
        fallbackUsed: false,
        iterations: {
          reinsertion: bestReinsertion,
          swap: bestSwap,
          twoOpt: bestTwoOpt,
        },
        segments,
      };
    } catch (error) {
      console.error("[optimizeRoute][fatal] erro não tratado:", error);

      if (error instanceof HttpsError) {
        throw error;
      }

      throw new HttpsError("internal", "Falha interna ao otimizar rota");
    }
  }
);

// ======================================================
// ================= STRIPE CONFIG ======================
// ======================================================

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY as string);
}

export const createCheckoutSession = onCall(
  {
    region: "us-central1",
    secrets: [STRIPE_SECRET_KEY],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Usuário não autenticado");
    }

    const stripe = getStripe();
    const userId = request.auth.uid;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: "price_1T5R45Fom5lf3GFgEjUGnXPC",
          quantity: 1,
        },
      ],
      metadata: {
        userId,
      },
      subscription_data: {
        trial_period_days: 7,
        metadata: {
          userId,
        },
      },
      success_url: "https://logiflow-dd382.web.app",
      cancel_url: "https://logiflow-dd382.web.app",
    });

    return {
      url: session.url,
    };
  }
);

export const webhookStripe = onRequest(
  {
    region: "us-central1",
    secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET],
  },
  async (req, res) => {
    const stripe = getStripe();
    const sig = req.headers["stripe-signature"] as string;

    if (!sig) {
      res.status(400).send("Missing Stripe signature");
      return;
    }

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET as string
      );
    } catch (err: any) {
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    const firestore = admin.firestore();

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.userId;

        if (userId) {
          await firestore.collection("subscriptions").doc(userId).set(
            {
              status: "trialing",
              stripeCustomerId: session.customer,
              stripeSubscriptionId: session.subscription,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = subscription.metadata?.userId;

        if (userId) {
          await firestore.collection("subscriptions").doc(userId).set(
            {
              status:
                subscription.status === "active" || subscription.status === "trialing"
                  ? subscription.status
                  : "expired",
              stripeCustomerId: subscription.customer,
              stripeSubscriptionId: subscription.id,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = subscription.metadata?.userId;

        if (userId) {
          await firestore.collection("subscriptions").doc(userId).set(
            {
              status: "expired",
              stripeCustomerId: subscription.customer,
              stripeSubscriptionId: subscription.id,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
        break;
      }
    }

    res.json({ received: true });
  }
);

export const expireTrialsDaily = onSchedule(
  {
    schedule: "every 24 hours",
    region: "us-central1",
  },
  async () => {
    console.log("Trial expiration check executed.");
  }
);