import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { useParams } from "react-router-dom";
import { db } from "../firebase";

export default function TrackingPage() {
  const { id } = useParams();
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);

  useEffect(() => {
    if (!id) return;

    const unsubscribe = onSnapshot(
      doc(db, "liveTracking", id),
      (snapshot) => {
        const data = snapshot.data();
        if (data) {
          setLat(data.lat);
          setLng(data.lng);
        }
      }
    );

    return () => unsubscribe();
  }, [id]);

  if (lat === null || lng === null) {
    return (
      <div style={{ padding: 20, textAlign: "center" }}>
        Obtendo localização do motorista...
      </div>
    );
  }

  const mapEmbed =
    `https://maps.google.com/maps?q=${lat},${lng}&z=15&output=embed`;

  const mapLink =
    `https://www.google.com/maps?q=${lat},${lng}`;

  return (
    <div style={{ padding: 20, textAlign: "center" }}>
      <h2>🚚 Motorista a caminho</h2>

      <iframe
        src={mapEmbed}
        width="100%"
        height="400"
        style={{ border: 0 }}
      />

      <br /><br />

      <a href={mapLink} target="_blank">
        📍 Abrir no Google Maps
      </a>
    </div>
  );
}
