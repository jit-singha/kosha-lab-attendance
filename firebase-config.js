// Firebase web app config (Firebase console → Project settings → Your apps).
// This is not a secret: access to data is protected by firestore.rules.
// If apiKey is empty, the app runs in DEMO MODE and stores data only in this browser.
export const firebaseConfig = {
  apiKey: 'AIzaSyBFsD7AxzbL4h6uS-bHIKWdUa-5h0VjScU',
  authDomain: 'kosha-lab-attendance.firebaseapp.com',
  projectId: 'kosha-lab-attendance',
  storageBucket: 'kosha-lab-attendance.firebasestorage.app',
  messagingSenderId: '23407856873',
  appId: '1:23407856873:web:6428661b1ce00abe273478',
};

// The owner's email. This account is always an admin and can give admin access to others.
// Use the same email in firestore.rules.
export const OWNER_EMAIL = 'js0234092@gmail.com';
