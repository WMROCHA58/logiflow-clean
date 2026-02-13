export function TrialExpiredNotice() {
  return (
    <div
      style={{
        marginTop: 24,
        padding: 20,
        borderRadius: 10,
        background: '#f8fafc',
        border: '1px solid #e5e7eb',
        maxWidth: 420,
      }}
    >
      <h3 style={{ marginTop: 0 }}>🚀 Continue usando o LogiFlow</h3>

      <p style={{ fontSize: 15 }}>
        Seu período gratuito de <strong>7 dias</strong> terminou.
        Para continuar usando todas as funcionalidades, escolha um plano:
      </p>

      <div
        style={{
          marginTop: 16,
          padding: 12,
          borderRadius: 8,
          background: '#ecfeff',
          border: '1px solid #67e8f9',
        }}
      >
        <p style={{ margin: 0 }}>
          💎 <strong>Plano Premium</strong>
        </p>
        <p style={{ margin: '4px 0' }}>
          ✔️ Acesso completo ao app  
          <br />
          ✔️ Comandos de voz  
          <br />
          ✔️ Leitura de endereço  
          <br />
          ✔️ Controle total de entregas
        </p>

        <p style={{ marginTop: 8, fontSize: 18 }}>
          <strong>R$ 29,00 / mês</strong>
        </p>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button
          style={{
            flex: 1,
            padding: '10px 0',
            borderRadius: 6,
            border: 'none',
            cursor: 'pointer',
            background: '#16a34a',
            color: '#fff',
            fontWeight: 'bold',
          }}
          onClick={() => alert('Assinatura mensal (R$ 29/mês)')}
        >
          Assinar mensal
        </button>

        <button
          style={{
            flex: 1,
            padding: '10px 0',
            borderRadius: 6,
            border: '1px solid #16a34a',
            cursor: 'pointer',
            background: '#fff',
            color: '#16a34a',
            fontWeight: 'bold',
          }}
          onClick={() => alert('Assinatura anual (desconto)')}
        >
          Assinar anual
        </button>
      </div>

      <p style={{ marginTop: 12, fontSize: 12, color: '#6b7280' }}>
        Cancele quando quiser. Sem fidelidade.
      </p>
    </div>
  )
}
