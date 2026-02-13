type Props = {
  name: string
  address: string
  city: string
  cep: string
  phone: string
  onAddToList: () => void
}

export function ScannerResultCard({
  name,
  address,
  city,
  cep,
  phone,
  onAddToList,
}: Props) {
  const fullAddress = `${address}, ${city}, CEP ${cep}`

  const openGoogleMaps = () => {
    window.open(
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        fullAddress
      )}`,
      "_blank"
    )
  }

  const openWaze = () => {
    window.open(
      `https://waze.com/ul?q=${encodeURIComponent(fullAddress)}`,
      "_blank"
    )
  }

  const openWhatsApp = () => {
    window.open(
      `https://wa.me/55${phone.replace(/\D/g, "")}`,
      "_blank"
    )
  }

  const callPhone = () => {
    window.location.href = `tel:${phone}`
  }

  return (
    <div
      style={{
        maxWidth: 420,
        margin: "40px auto",
        padding: 20,
        borderRadius: 16,
        background: "#fff",
        boxShadow: "0 10px 30px rgba(0,0,0,0.1)",
        fontFamily: "sans-serif",
      }}
    >
      <h2>{name}</h2>

      <p>📍 {address}</p>
      <p>{city}</p>
      <p>
        <strong>CEP:</strong> {cep}
      </p>

      <p>📞 {phone}</p>

      <div
        style={{
          marginTop: 10,
          padding: 8,
          background: "#e6fffa",
          borderRadius: 8,
          color: "#065f46",
          fontSize: 14,
        }}
      >
        ⚡ Endereço validado com sucesso
      </div>

      <button
        onClick={onAddToList}
        style={{
          width: "100%",
          marginTop: 16,
          padding: 14,
          background: "#16a34a",
          color: "#fff",
          border: "none",
          borderRadius: 10,
          fontSize: 16,
          cursor: "pointer",
        }}
      >
        Enviar para Lista
      </button>

      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        <button
          onClick={openGoogleMaps}
          style={{
            flex: 1,
            padding: 12,
            background: "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: 10,
            cursor: "pointer",
          }}
        >
          Google Maps
        </button>

        <button
          onClick={openWaze}
          style={{
            flex: 1,
            padding: 12,
            background: "#06b6d4",
            color: "#fff",
            border: "none",
            borderRadius: 10,
            cursor: "pointer",
          }}
        >
          Waze
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
        <button
          onClick={openWhatsApp}
          style={{
            flex: 1,
            padding: 12,
            background: "#22c55e",
            color: "#fff",
            border: "none",
            borderRadius: 10,
            cursor: "pointer",
          }}
        >
          WhatsApp
        </button>

        <button
          onClick={callPhone}
          style={{
            flex: 1,
            padding: 12,
            background: "#4b5563",
            color: "#fff",
            border: "none",
            borderRadius: 10,
            cursor: "pointer",
          }}
        >
          Ligar
        </button>
      </div>
    </div>
  )
}
