// 1) No console do Firebase: Configurações do projeto (engrenagem) → Seus apps → app da Web (</>).
// 2) Copie o bloco "firebaseConfig" que aparece lá e cole no lugar do exemplo abaixo.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyB9I1QtvJnlQDof1wjySNtwPLIXk5ZZQfI",
  authDomain: "sistema-tenda.firebaseapp.com",
  projectId: "sistema-tenda",
  storageBucket: "sistema-tenda.firebasestorage.app",
  messagingSenderId: "1030753114569",
  appId: "1:1030753114569:web:4ecaff163089e7751ef018"
};

// E-mail(s) do administrador: pode tudo, inclusive liberar a equipe e fazer backup.
// Se mudar aqui, mude também no arquivo firestore.rules.
window.ADMIN_EMAILS = ["jr.alvani22@gmail.com"];
