import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyDub5hI6Ohm4FE_4VOUncikAlpKASXuW6E",
  authDomain: "logiflow-dd382.firebaseapp.com",
  projectId: "logiflow-dd382",
  storageBucket: "logiflow-dd382.firebasestorage.app",
  messagingSenderId: "44137203243",
  appId: "1:44137203243:web:2f87ae57ebea56167ccc6e"
};

export const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, "us-central1");

// ⭐ NOVO — STORAGE
export const storage = getStorage(app);
