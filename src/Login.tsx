import { useState } from "react";
import { auth } from "./firebase";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from "firebase/auth";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function login() {
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      alert("Erro ao entrar");
    }
  }

  async function register() {
    try {
      await createUserWithEmailAndPassword(auth, email, password);
    } catch (error) {
      alert("Erro ao criar conta");
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 400, margin: "100px auto" }}>
      <h2>Login LogiFlow</h2>

      <input
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={{ width: "100%", padding: 10, marginBottom: 10 }}
      />

      <input
        type="password"
        placeholder="Senha"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        style={{ width: "100%", padding: 10, marginBottom: 10 }}
      />

      <button
        onClick={login}
        style={{
          width: "100%",
          padding: 12,
          marginBottom: 10,
          background: "#2563eb",
          color: "#fff",
          border: "none",
        }}
      >
        Entrar
      </button>

      <button
        onClick={register}
        style={{
          width: "100%",
          padding: 12,
          background: "#111",
          color: "#fff",
          border: "none",
        }}
      >
        Criar Conta
      </button>
    </div>
  );
}
