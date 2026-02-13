type Props = {
  onClick: () => void;
};

export function FloatingVoiceButton({ onClick }: Props) {
  return (
    <button
      onClick={onClick}
      style={{
        position: 'fixed',
        right: 120,
        bottom: 120,
        width: 64,
        height: 64,
        borderRadius: '50%',
        fontSize: 26,
        background: '#10b981',
        color: '#fff',
        border: 'none',
        cursor: 'pointer',
        zIndex: 9999,
      }}
      title="Comando de voz"
    >
      🎤
    </button>
  );
}
