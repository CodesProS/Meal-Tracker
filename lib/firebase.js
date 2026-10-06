// ─────────────────────────────────────────────────────────────────────────────
// Firebase configuration
//
// HOW TO SET THIS UP:
//  1. Go to https://console.firebase.google.com and create a new project.
//  2. In the project, click "Add app" → Web (</> icon).
//  3. Copy the firebaseConfig values below from the setup screen.
//  4. In the Firebase console, go to Build → Firestore Database → Create database.
//     Choose "Start in test mode" (you can add security rules later).
//  5. Done — run the app and follow the in-app setup to create your family group.
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyA77davH7ZP7HsjdISBXbPIJan1AMMhmn8",
  authDomain: "mealtr-4349a.firebaseapp.com",
  projectId: "mealtr-4349a",
  storageBucket: "mealtr-4349a.firebasestorage.app",
  messagingSenderId: "762402684121",
  appId: "1:762402684121:web:a00fbfb8f41c4b6f53d2c8",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
