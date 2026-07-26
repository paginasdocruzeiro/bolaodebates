window.BOLAO_FIREBASE_CONFIG = {
  apiKey: "AIzaSyD64uWtbeC-KKsxd6SQiOffL8AoMlZxlPQ",
  authDomain: "bolao-cruzeiro-debates.firebaseapp.com",
  databaseURL: "https://bolao-cruzeiro-debates-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "bolao-cruzeiro-debates",
  storageBucket: "bolao-cruzeiro-debates.firebasestorage.app",
  messagingSenderId: "512555602218",
  appId: "1:512555602218:web:b63b7ce03766b0cb6ece53"
};

window.BOLAO_FIREBASE_PATH = "bolao-cruzeiro-debates/state";
window.BOLAO_FOOTBALL_KEY = "f6a28bbf32734ec9a90f7f9a5c9e7f04";
window.BOLAO_WORKER_URL = "https://football-proxy.ivochagas.workers.dev";

// Carrega a correção depois que app.js e os demais scripts terminarem.
window.addEventListener('load', () => {
  if (window.__BOLAO_ROUND_HOTFIX_LOADING__) return;
  window.__BOLAO_ROUND_HOTFIX_LOADING__ = true;

  const script = document.createElement('script');
  script.src = './hotfix-rodadas.js?v=20260726-1';
  script.async = false;
  script.onerror = () => console.error('Não foi possível carregar hotfix-rodadas.js');
  document.body.appendChild(script);
});
